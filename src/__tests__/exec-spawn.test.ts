import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real process-boundary tests for `fio-vault exec`. The critical assert — that the
// raw secret never appears in exec's OWN stdout/stderr — only holds at a true
// process boundary, so these spawn the actual CLI with a real GPG-encrypted vault.

const SECRET = "S3CR3T-boundary-9f2a-DO-NOT-LEAK";
const PASSPHRASE = "test-passphrase";
const cliPath = join(import.meta.dir, "..", "cli.ts");

let baseDir: string;
let projectDir: string;
let gnupgDir: string;
let homeDir: string;

async function sh(cmd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const err = await new Response(proc.stderr).text();
  if (code !== 0) throw new Error(`setup failed: ${cmd}\n${err}`);
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    env: {
      ...process.env,
      HOME: homeDir, // isolate getGlobalVaultDir() from the real ~/.fio-vault
      GNUPGHOME: gnupgDir,
      FIO_VAULT_PASSPHRASE: PASSPHRASE,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code, out, err };
}

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "fio-vault-spawn-"));
  projectDir = join(baseDir, "project");
  gnupgDir = join(baseDir, "gnupg");
  homeDir = join(baseDir, "home");
  mkdirSync(join(projectDir, "vault"), { recursive: true });
  mkdirSync(gnupgDir, { recursive: true, mode: 0o700 });
  mkdirSync(homeDir, { recursive: true });

  // Generate a throwaway key (fast ed25519 default) and encrypt the secret to it.
  await sh(
    `gpg --batch --pinentry-mode loopback --passphrase "${PASSPHRASE}" ` +
      `--quick-generate-key "vault@test" default default never`,
    { GNUPGHOME: gnupgDir },
  );
  const gpgFile = join(projectDir, "vault", "api-key.gpg");
  await sh(
    `printf '%s' "${SECRET}" | gpg --batch --yes --trust-model always ` +
      `--encrypt --recipient "vault@test" -o "${gpgFile}"`,
    { GNUPGHOME: gnupgDir },
  );
  writeFileSync(
    join(projectDir, "vault", "manifest.json"),
    JSON.stringify({ "api-key": "API_KEY" }),
  );
}, 30_000);

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("exec (real process boundary)", () => {
  test("injects the real decrypted secret AND never leaks it on exec's own output", async () => {
    const outFile = join(projectDir, "child-out.txt");
    const { code, out, err } = await runCli([
      "exec",
      "--cwd",
      projectDir,
      "--",
      "bash",
      "-c",
      `printf '%s' "$API_KEY" > "${outFile}"`,
    ]);

    expect(code).toBe(0);
    // Injection works through real GPG decryption:
    expect(readFileSync(outFile, "utf-8")).toBe(SECRET);
    // Critical assert: the raw secret never appears in exec's own stdout/stderr.
    expect(out).not.toContain(SECRET);
    expect(err).not.toContain(SECRET);
  }, 15_000);

  test("passes the child's exit code through", async () => {
    const { code } = await runCli(["exec", "--cwd", projectDir, "--", "bash", "-c", "exit 7"]);
    expect(code).toBe(7);
  }, 15_000);

  test("missing `--` separator → exit 1 with usage, no decryption", async () => {
    const { code, out, err } = await runCli(["exec", "--cwd", projectDir, "env"]);
    expect(code).toBe(1);
    expect(out + err).not.toContain(SECRET);
    expect(err).toContain("--");
  }, 15_000);

  test("forwards SIGTERM to the child (parent → child)", async () => {
    const marker = join(projectDir, "term-marker.txt");
    const ready = join(projectDir, "child-ready.txt");
    rmSync(marker, { force: true });
    rmSync(ready, { force: true });

    const proc = Bun.spawn(
      [
        "bun",
        cliPath,
        "exec",
        "--cwd",
        projectDir,
        "--",
        "bash",
        "-c",
        `trap 'printf got-term > "${marker}"; exit 0' TERM; printf ready > "${ready}"; while true; do sleep 0.05; done`,
      ],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          GNUPGHOME: gnupgDir,
          FIO_VAULT_PASSPHRASE: PASSPHRASE,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    // Wait until the child has installed its trap, then signal the exec PARENT.
    for (let i = 0; i < 150 && !existsSync(ready); i++) await Bun.sleep(20);
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGTERM");

    const code = await proc.exited;
    // The parent forwarded SIGTERM; the child trapped it and exited 0 cleanly.
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf-8")).toBe("got-term");
    expect(code).toBe(0);
  }, 15_000);

  test("malformed flags → clean exit 1, no raw stack trace", async () => {
    // `--only` with no value before `--` makes parseArgs throw; it must surface
    // as a one-line message, not an uncaught stack trace.
    const ambiguous = await runCli(["exec", "--cwd", projectDir, "--only", "--", "env"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).not.toMatch(/\bat .*cli\.ts/);

    // An invalid --only key fails key validation cleanly.
    const badKey = await runCli(["exec", "--cwd", projectDir, "--only", "bad/key", "--", "env"]);
    expect(badKey.code).toBe(1);
    expect(badKey.err).toContain("Invalid key");
    expect(badKey.err).not.toMatch(/\bat .*cli\.ts/);
  }, 15_000);
});
