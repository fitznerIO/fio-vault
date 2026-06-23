import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cmdInit, _prompts } from "../cli";
import * as gpg from "../gpg";

const cliPath = join(import.meta.dir, "..", "cli.ts");

// Use a SHORT base dir (not the long macOS /var/folders tmpdir): the gpg-agent
// Unix socket path has a ~104-char limit, and a long GNUPGHOME makes the agent
// fail to start ("can't connect to the gpg-agent: IPC connect call failed"),
// which breaks secret-key import on a fresh keyring.
const SHORT_TMP = "/tmp";

// ---------------------------------------------------------------------------
// F1/F2/F3 — the no-passphrase ("%no-protection") unattended mode.
//
// These are REAL process-boundary tests against a real gpg with an isolated
// GNUPGHOME — the only way to verify the %no-protection mechanics the PRD §3
// asserts (a no-protection key decrypts headless, no TTY, no FIO_VAULT_PASSPHRASE,
// via the existing `pass show` path). This file is the repo-test anchor the PRD
// promised for that empirically-observed behavior.
// ---------------------------------------------------------------------------

describe("init --no-passphrase (real gpg, isolated GNUPGHOME)", () => {
  let baseDir: string;
  let projectDir: string;
  let gnupgDir: string;
  let homeDir: string;

  async function run(args: string[], env: Record<string, string> = {}, stdin?: string) {
    const proc = Bun.spawn(["bun", cliPath, ...args], {
      env: {
        ...process.env,
        HOME: homeDir, // isolate the global vault from the real ~/.fio-vault
        GNUPGHOME: gnupgDir,
        ...env,
      },
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return { code, out, err };
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(SHORT_TMP, "fv-init-"));
    projectDir = join(baseDir, "project");
    gnupgDir = join(baseDir, "gnupg");
    homeDir = join(baseDir, "home");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(gnupgDir, { recursive: true, mode: 0o700 });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("generates a %no-protection key — vault.key has no passphrase", async () => {
    const { code, err } = await run(["init", "--no-passphrase", "--cwd", projectDir]);
    expect(code).toBe(0);
    // The loud at-rest warning must appear.
    expect(err + "").toMatch(/NO passphrase|filesystem permissions/i);

    const keyFile = join(projectDir, "vault", "vault.key");
    expect(existsSync(keyFile)).toBe(true);

    // The exported secret key must be importable WITHOUT a passphrase — proof it
    // is %no-protection and not passphrase-encrypted.
    const probeHome = join(baseDir, "probe-gnupg");
    mkdirSync(probeHome, { recursive: true, mode: 0o700 });
    const imp = Bun.spawn(["gpg", "--batch", "--import", keyFile], {
      env: { ...process.env, GNUPGHOME: probeHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await imp.exited).toBe(0);
  }, 60_000);

  test("a no-passphrase vault decrypts headless with FIO_VAULT_PASSPHRASE unset", async () => {
    // init, seed a secret, then read it back with NO passphrase in the env and a
    // cold agent — the core PRD claim.
    expect((await run(["init", "--no-passphrase", "--cwd", projectDir])).code).toBe(0);

    const set = await run(["set", "api-key", "--stdin", "--cwd", projectDir], {}, "headless-value\n");
    expect(set.code).toBe(0);

    // Kill any agent so the read happens cold; ensure no passphrase is present.
    Bun.spawnSync(["gpgconf", "--kill", "gpg-agent"], { env: { ...process.env, GNUPGHOME: gnupgDir } });

    const get = await run(
      ["get", "api-key", "--cwd", projectDir, "--allow-raw"],
      { FIO_VAULT_PASSPHRASE: "" }, // explicitly empty — must NOT be needed
    );
    expect(get.code).toBe(0);
    expect(get.out).toBe("headless-value");
  }, 60_000);

  test("default init still REQUIRES a passphrase (empty → exit 1, no key)", async () => {
    // In-process: the default init path is readline-driven and doesn't drive over a
    // pipe, so stub the prompts. Empty name/email (→ defaults), empty passphrase →
    // the "Passphrase is required" guard must fire BEFORE any key is generated.
    // Mock isPassAvailable so this pure in-process unit test runs hermetically even
    // on a host without `pass` (the passphrase guard fires before any pass call).
    const passSpy = spyOn(gpg, "isPassAvailable").mockResolvedValue(true);
    const promptSpy = spyOn(_prompts, "prompt").mockResolvedValue("");
    const secretSpy = spyOn(_prompts, "promptSecret").mockResolvedValue(""); // empty passphrase
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code ?? 0}`);
    }) as never);

    let thrown: Error | undefined;
    try {
      await cmdInit(projectDir, false, false); // no --no-passphrase → interactive default
    } catch (e) {
      thrown = e as Error;
    }

    // Guard tripped with exit(1), and no key material was written.
    expect(thrown?.message).toBe("__exit__:1");
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Passphrase is required/i);
    expect(existsSync(join(projectDir, "vault", "vault.key"))).toBe(false);

    passSpy.mockRestore();
    promptSpy.mockRestore();
    secretSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// F2 — onboard parity: importing a no-passphrase key must not dead-end at the
// passphrase prompt, and must not instruct the user to export FIO_VAULT_PASSPHRASE.
// ---------------------------------------------------------------------------

describe("onboard --no-passphrase parity (real gpg)", () => {
  let baseDir: string;
  let projectDir: string;
  let gnupgDir: string;
  let freshGnupg: string;
  let homeDir: string;

  async function run(args: string[], gnupg: string, env: Record<string, string> = {}, stdin?: string) {
    const proc = Bun.spawn(["bun", cliPath, ...args], {
      env: { ...process.env, HOME: homeDir, GNUPGHOME: gnupg, ...env },
      stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return { code, out, err };
  }

  beforeAll(async () => {
    baseDir = mkdtempSync(join(SHORT_TMP, "fv-onb-"));
    projectDir = join(baseDir, "project");
    gnupgDir = join(baseDir, "gnupg");
    freshGnupg = join(baseDir, "fresh-gnupg"); // simulates a new machine
    homeDir = join(baseDir, "home");
    [gnupgDir, freshGnupg].forEach((d) => mkdirSync(d, { recursive: true, mode: 0o700 }));
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    // Build a no-passphrase vault on the "first" machine.
    const init = await run(["init", "--no-passphrase", "--cwd", projectDir], gnupgDir);
    if (init.code !== 0) throw new Error(`init setup failed: ${init.err}`);
    const set = await run(["set", "api-key", "--stdin", "--cwd", projectDir], gnupgDir, {}, "onboard-value\n");
    if (set.code !== 0) throw new Error(`set setup failed: ${set.err}`);
  }, 60_000);

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("onboard --no-passphrase imports the key and verifies WITHOUT a passphrase prompt", async () => {
    // Fresh GNUPGHOME (no key yet). With the flag, onboard must import, verify
    // decryption with no passphrase, and finish — never blocking on a passphrase
    // prompt (stdin is closed).
    const { code, out } = await run(
      ["onboard", "--no-passphrase", "--cwd", projectDir],
      freshGnupg,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/no passphrase|nothing to set/i);
    expect(out).not.toMatch(/export FIO_VAULT_PASSPHRASE/);
    expect(out).toMatch(/1\/1 secrets readable/);
  }, 60_000);
});
