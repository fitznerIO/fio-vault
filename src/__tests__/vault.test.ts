import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as gpg from "../gpg";
import { loadSecrets, listKeys, getSecret, isConfigured } from "../vault";

describe("vault", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let isConfiguredSpy: ReturnType<typeof spyOn>;
  let decryptSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fio-vault-test-"));
    mkdirSync(join(tmpDir, "vault"), { recursive: true });

    // Mock gpg functions
    isConfiguredSpy = spyOn(gpg, "isConfigured").mockResolvedValue(true);
    decryptSpy = spyOn(gpg, "decrypt").mockResolvedValue(null);

    // Save env vars
    savedEnv.API_KEY = process.env.API_KEY;
    savedEnv.BOT_TOKEN = process.env.BOT_TOKEN;
    savedEnv.GLOBAL_TOKEN = process.env.GLOBAL_TOKEN;
    delete process.env.API_KEY;
    delete process.env.BOT_TOKEN;
    delete process.env.GLOBAL_TOKEN;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    isConfiguredSpy.mockRestore();
    decryptSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  function writeManifest(data: Record<string, string>) {
    writeFileSync(join(tmpDir, "vault", "manifest.json"), JSON.stringify(data));
  }

  function mockSecrets(secrets: Record<string, string>) {
    decryptSpy.mockImplementation(async (key: string) => secrets[key] ?? null);
  }

  describe("loadSecrets", () => {
    test("loads secrets into process.env", async () => {
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "secret-123", "bot-token": "token-456" });

      await loadSecrets({ cwd: tmpDir, global: false });

      expect(process.env.API_KEY).toBe("secret-123");
      expect(process.env.BOT_TOKEN).toBe("token-456");
    });

    test("does not overwrite already-set env vars", async () => {
      process.env.API_KEY = "existing";
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "from-vault", "bot-token": "token-456" });

      await loadSecrets({ cwd: tmpDir, global: false });

      expect(process.env.API_KEY).toBe("existing");
      expect(process.env.BOT_TOKEN).toBe("token-456");
    });

    test("does not overwrite env var set to empty string", async () => {
      process.env.API_KEY = "";
      writeManifest({ "api-key": "API_KEY" });
      mockSecrets({ "api-key": "from-vault" });

      await loadSecrets({ cwd: tmpDir, global: false });

      expect(process.env.API_KEY).toBe("");
    });

    test("skips gracefully when not configured", async () => {
      isConfiguredSpy.mockResolvedValue(false);
      writeManifest({ "api-key": "API_KEY" });
      mockSecrets({ "api-key": "secret" });

      await loadSecrets({ cwd: tmpDir, global: false });

      expect(process.env.API_KEY).toBeUndefined();
    });

    test("handles missing manifest gracefully", async () => {
      await loadSecrets({ cwd: tmpDir, global: false });
      expect(process.env.API_KEY).toBeUndefined();
    });

    test("handles partial vault (some secrets missing)", async () => {
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "secret-123" });

      await loadSecrets({ cwd: tmpDir, global: false });

      expect(process.env.API_KEY).toBe("secret-123");
      expect(process.env.BOT_TOKEN).toBeUndefined();
    });
  });

  describe("listKeys", () => {
    test("returns status for each secret", async () => {
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "exists" });

      const keys = await listKeys({ cwd: tmpDir, global: false });

      expect(keys).toEqual([
        { key: "api-key", envVar: "API_KEY", exists: true, source: "project" },
        { key: "bot-token", envVar: "BOT_TOKEN", exists: false, source: "project" },
      ]);
    });

    test("returns empty array for empty manifest", async () => {
      const keys = await listKeys({ cwd: tmpDir, global: false });
      expect(keys).toEqual([]);
    });
  });

  describe("getSecret", () => {
    test("returns decrypted value", async () => {
      mockSecrets({ "api-key": "my-secret" });
      const value = await getSecret("api-key", { cwd: tmpDir, global: false });
      expect(value).toBe("my-secret");
    });

    test("returns null for missing secret", async () => {
      const value = await getSecret("nonexistent", { cwd: tmpDir, global: false });
      expect(value).toBeNull();
    });

    test("returns secret with special characters intact", async () => {
      mockSecrets({ "db-url": "postgres://user:p@ss=w0rd!&special/db?ssl=true" });
      const value = await getSecret("db-url", { cwd: tmpDir, global: false });
      expect(value).toBe("postgres://user:p@ss=w0rd!&special/db?ssl=true");
    });

    test("returns multiline secret intact", async () => {
      const multiline = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
      mockSecrets({ "ssh-key": multiline });
      const value = await getSecret("ssh-key", { cwd: tmpDir, global: false });
      expect(value).toBe(multiline);
    });
  });

  describe("isConfigured", () => {
    test("delegates to gpg module", async () => {
      expect(await isConfigured()).toBe(true);
      expect(isConfiguredSpy).toHaveBeenCalled();
    });
  });

  describe("global vault", () => {
    let globalDir: string;

    beforeEach(() => {
      globalDir = mkdtempSync(join(tmpdir(), "fio-vault-global-"));
      mkdirSync(join(globalDir, "vault"), { recursive: true });
    });

    afterEach(() => {
      rmSync(globalDir, { recursive: true, force: true });
    });

    function writeGlobalManifest(data: Record<string, string>) {
      writeFileSync(join(globalDir, "vault", "manifest.json"), JSON.stringify(data));
    }

    test("loadSecrets loads from both project and global vault", async () => {
      // We test the dual-vault logic by using two separate cwd dirs
      // and calling loadSecrets twice (simulating what vault.ts does internally)
      writeManifest({ "api-key": "API_KEY" });
      writeGlobalManifest({ "global-token": "GLOBAL_TOKEN" });

      // Mock decrypt to return values based on key
      mockSecrets({ "api-key": "project-secret", "global-token": "global-secret" });

      // Load project vault
      await loadSecrets({ cwd: tmpDir, global: false });
      expect(process.env.API_KEY).toBe("project-secret");

      // Load global vault separately (simulates fallback)
      await loadSecrets({ cwd: globalDir, global: false });
      expect(process.env.GLOBAL_TOKEN).toBe("global-secret");
    });

    test("project vault takes priority over global for same env var", async () => {
      writeManifest({ "api-key": "API_KEY" });
      mockSecrets({ "api-key": "project-value" });

      await loadSecrets({ cwd: tmpDir, global: false });
      expect(process.env.API_KEY).toBe("project-value");

      // Even if global has same env var, it should not overwrite
      writeGlobalManifest({ "api-key": "API_KEY" });
      decryptSpy.mockImplementation(async () => "global-value");

      await loadSecrets({ cwd: globalDir, global: false });
      // No-overwrite semantics: project value wins
      expect(process.env.API_KEY).toBe("project-value");
    });

    test("listKeys includes source field", async () => {
      writeManifest({ "api-key": "API_KEY" });
      mockSecrets({ "api-key": "exists" });

      const keys = await listKeys({ cwd: tmpDir, global: false });

      expect(keys[0].source).toBe("project");
    });
  });
});
