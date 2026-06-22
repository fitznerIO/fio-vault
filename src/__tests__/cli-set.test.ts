import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdSet } from "../cli";

const PASSPHRASE = "test-passphrase";
const cliPath = join(import.meta.dir, "..", "cli.ts");

// --- In-process: --stdin guard against an interactive terminal ---

describe("cmdSet --stdin guard (in-process)", () => {
  let tmp: string;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  const savedIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fio-vault-set-"));
    mkdirSync(join(tmp, "vault"), { recursive: true });
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    consoleErrorSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedIsTTY,
      configurable: true,
      writable: true,
    });
  });

  test("--stdin at an interactive TTY → exit 1, no manifest written", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    const code = await cmdSet("api-key", undefined, tmp, false, true);
    expect(code).toBe(1);
    // guard short-circuits before reading stdin or touching the manifest
    expect(existsSync(join(tmp, "vault", "manifest.json"))).toBe(false);
  });
});

// --- Real process boundary: --stdin store / trim / empty handling ---

describe("set --stdin (real process boundary)", () => {
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
    if ((await proc.exited) !== 0) {
      throw new Error(`setup failed: ${cmd}\n${await new Response(proc.stderr).text()}`);
    }
  }

  function cliEnv() {
    return {
      ...process.env,
      HOME: homeDir, // isolate the global vault from the real ~/.fio-vault
      GNUPGHOME: gnupgDir,
      FIO_VAULT_PASSPHRASE: PASSPHRASE,
    };
  }

  async function runSet(key: string, input: string) {
    const proc = Bun.spawn(["bun", cliPath, "set", key, "--stdin", "--cwd", projectDir], {
      env: cliEnv(),
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return { code, out, err };
  }

  async function readBack(key: string) {
    const proc = Bun.spawn(["bun", cliPath, "get", key, "--cwd", projectDir, "--allow-raw"], {
      env: cliEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return await new Response(proc.stdout).text();
  }

  function manifest(): Record<string, string> {
    const path = join(projectDir, "vault", "manifest.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  }

  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), "fio-vault-setspawn-"));
    projectDir = join(baseDir, "project");
    gnupgDir = join(baseDir, "gnupg");
    homeDir = join(baseDir, "home");
    mkdirSync(join(projectDir, "vault"), { recursive: true });
    mkdirSync(gnupgDir, { recursive: true, mode: 0o700 });
    mkdirSync(homeDir, { recursive: true });

    await sh(
      `gpg --batch --pinentry-mode loopback --passphrase "${PASSPHRASE}" ` +
        `--quick-generate-key "vault@test" default default never`,
      { GNUPGHOME: gnupgDir },
    );
    // Initialize the pass store: a .gpg-id naming the recipient key.
    writeFileSync(join(projectDir, "vault", ".gpg-id"), "vault@test\n");
  }, 30_000);

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("stores a value read from stdin and registers the manifest entry", async () => {
    const { code } = await runSet("api-key", "my-secret-value\n");
    expect(code).toBe(0);
    expect(manifest()["api-key"]).toBe("API_KEY");
    expect(await readBack("api-key")).toBe("my-secret-value");
  }, 15_000);

  test("trims exactly one trailing newline and preserves inner newlines", async () => {
    const { code } = await runSet("multi-line", "line1\nline2\n");
    expect(code).toBe(0);
    expect(await readBack("multi-line")).toBe("line1\nline2");
  }, 15_000);

  test("empty stdin → exit 1 and no manifest entry (no orphan)", async () => {
    const { code, err } = await runSet("empty-key", "");
    expect(code).toBe(1);
    expect(err).toContain("empty");
    expect("empty-key" in manifest()).toBe(false);
    expect(existsSync(join(projectDir, "vault", "empty-key.gpg"))).toBe(false);
  }, 15_000);

  test("stdin of only a newline → empty after trim → exit 1, no entry", async () => {
    const { code } = await runSet("newline-only", "\n");
    expect(code).toBe(1);
    expect("newline-only" in manifest()).toBe(false);
  }, 15_000);

  // No-echo of the interactive prompt is TTY-bound and requires a pseudo-terminal
  // to observe. Recommended PTY/integration check (see PRD §8): drive `set` over a
  // PTY and assert the captured terminal output never contains the typed value.
  // Skipped here to avoid a node-pty dependency (no external runtime deps).
  test.skip("no-echo: typed value absent from terminal output (PTY)", () => {});
});
