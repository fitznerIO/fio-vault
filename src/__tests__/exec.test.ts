import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as gpg from "../gpg";
import * as utils from "../utils";
import { runExec } from "../exec";

describe("exec", () => {
  let projectDir: string;
  let globalDir: string;
  let outFile: string;
  let isConfiguredSpy: ReturnType<typeof spyOn>;
  let decryptSpy: ReturnType<typeof spyOn>;
  let globalDirSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let stderr: string[];
  const savedPassphrase = process.env.FIO_VAULT_PASSPHRASE;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "fio-vault-exec-"));
    globalDir = mkdtempSync(join(tmpdir(), "fio-vault-execg-"));
    mkdirSync(join(projectDir, "vault"), { recursive: true });
    mkdirSync(join(globalDir, "vault"), { recursive: true });
    outFile = join(projectDir, "out.txt");

    isConfiguredSpy = spyOn(gpg, "isConfigured").mockResolvedValue(true);
    decryptSpy = spyOn(gpg, "decrypt").mockResolvedValue(null);
    // Isolate the global-vault fallback from the real ~/.fio-vault.
    globalDirSpy = spyOn(utils, "getGlobalVaultDir").mockReturnValue(globalDir);

    stderr = [];
    consoleErrorSpy = spyOn(console, "error").mockImplementation((...args: any[]) => {
      stderr.push(args.join(" "));
    });

    delete process.env.FIO_VAULT_PASSPHRASE;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
    isConfiguredSpy.mockRestore();
    decryptSpy.mockRestore();
    globalDirSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (savedPassphrase !== undefined) process.env.FIO_VAULT_PASSPHRASE = savedPassphrase;
    else delete process.env.FIO_VAULT_PASSPHRASE;
  });

  function writeManifest(dir: string, data: Record<string, string>) {
    writeFileSync(join(dir, "vault", "manifest.json"), JSON.stringify(data));
  }
  function touchGpg(dir: string, key: string) {
    writeFileSync(join(dir, "vault", `${key}.gpg`), "encrypted-bytes");
  }
  function mockSecrets(secrets: Record<string, string>) {
    decryptSpy.mockImplementation(async (key: string) => secrets[key] ?? null);
  }
  /** bash snippet that writes the given shell expression to outFile. */
  function writeVar(expr: string): string[] {
    return ["bash", "-c", `printf '%s' "${expr}" > "${outFile}"`];
  }

  test("injects the secret as an env var into the child", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" });
    touchGpg(projectDir, "api-key");
    mockSecrets({ "api-key": "secret-123" });

    const code = await runExec(writeVar("$API_KEY"), { cwd: projectDir });

    expect(code).toBe(0);
    expect(readFileSync(outFile, "utf-8")).toBe("secret-123");
  });

  test("passes the child's exit code through", async () => {
    const code = await runExec(["bash", "-c", "exit 42"], { cwd: projectDir });
    expect(code).toBe(42);
  });

  test("passes a signal exit (128+signum) through", async () => {
    const code = await runExec(["bash", "-c", "kill -TERM $$"], { cwd: projectDir });
    expect(code).toBe(143); // 128 + 15 (SIGTERM)
  });

  test("strips FIO_VAULT_PASSPHRASE from the child env", async () => {
    process.env.FIO_VAULT_PASSPHRASE = "master-passphrase";
    const code = await runExec(writeVar("[$FIO_VAULT_PASSPHRASE]"), { cwd: projectDir });
    expect(code).toBe(0);
    expect(readFileSync(outFile, "utf-8")).toBe("[]");
  });

  test("pre-gate: vault not configured → exit 1, child never starts", async () => {
    isConfiguredSpy.mockResolvedValue(false);
    const code = await runExec(["bash", "-c", `echo ran > "${outFile}"`], { cwd: projectDir });
    expect(code).toBe(1);
    expect(existsSync(outFile)).toBe(false);
  });

  test("missing child argv → exit 1", async () => {
    const code = await runExec([], { cwd: projectDir });
    expect(code).toBe(1);
  });

  test(".gpg missing → warns on stderr, skips var, child still runs", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" }); // no .gpg file
    const code = await runExec(writeVar("[$API_KEY]"), { cwd: projectDir });
    expect(code).toBe(0);
    expect(readFileSync(outFile, "utf-8")).toBe("[]");
    expect(stderr.join("\n")).toContain("no encrypted file");
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  test(".gpg present but decryption fails → exit 1, child never starts", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" });
    touchGpg(projectDir, "api-key");
    decryptSpy.mockResolvedValue(null); // decryption fails
    const code = await runExec(["bash", "-c", `echo ran > "${outFile}"`], { cwd: projectDir });
    expect(code).toBe(1);
    expect(existsSync(outFile)).toBe(false);
    expect(stderr.join("\n")).toContain("could not be decrypted");
  });

  test("--only filters to the named manifest keys, with global fallback", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" });
    touchGpg(projectDir, "api-key");
    writeManifest(globalDir, { "global-token": "GLOBAL_TOKEN" });
    touchGpg(globalDir, "global-token");
    mockSecrets({ "api-key": "proj", "global-token": "glob" });

    const code = await runExec(writeVar("[$GLOBAL_TOKEN][$API_KEY]"), {
      cwd: projectDir,
      only: ["global-token"],
    });

    expect(code).toBe(0);
    // only the requested key (resolved from global fallback) is injected
    expect(readFileSync(outFile, "utf-8")).toBe("[glob][]");
  });

  test("--only with a key in no manifest → exit 1", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" });
    touchGpg(projectDir, "api-key");
    const code = await runExec(["true"], { cwd: projectDir, only: ["does-not-exist"] });
    expect(code).toBe(1);
  });

  test("--global uses only the global vault", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" });
    touchGpg(projectDir, "api-key");
    writeManifest(globalDir, { "global-token": "GLOBAL_TOKEN" });
    touchGpg(globalDir, "global-token");
    mockSecrets({ "api-key": "proj", "global-token": "glob" });

    const code = await runExec(writeVar("[$API_KEY][$GLOBAL_TOKEN]"), {
      cwd: projectDir,
      global: true,
    });

    expect(code).toBe(0);
    // project key NOT injected; only the global vault is consulted
    expect(readFileSync(outFile, "utf-8")).toBe("[][glob]");
  });

  test("decrypt is invoked with the resolving vault dir as cwd", async () => {
    writeManifest(projectDir, { "api-key": "API_KEY" });
    touchGpg(projectDir, "api-key");
    mockSecrets({ "api-key": "proj" });

    await runExec(["true"], { cwd: projectDir });

    expect(decryptSpy).toHaveBeenCalledWith("api-key", { cwd: projectDir });
  });
});
