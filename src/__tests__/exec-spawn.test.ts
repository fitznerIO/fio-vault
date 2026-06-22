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
});
