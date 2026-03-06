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
    delete process.env.API_KEY;
    delete process.env.BOT_TOKEN;
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

      await loadSecrets({ cwd: tmpDir });

      expect(process.env.API_KEY).toBe("secret-123");
      expect(process.env.BOT_TOKEN).toBe("token-456");
    });

    test("does not overwrite already-set env vars", async () => {
      process.env.API_KEY = "existing";
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "from-vault", "bot-token": "token-456" });

      await loadSecrets({ cwd: tmpDir });

      expect(process.env.API_KEY).toBe("existing");
      expect(process.env.BOT_TOKEN).toBe("token-456");
    });

    test("does not overwrite env var set to empty string", async () => {
      process.env.API_KEY = "";
      writeManifest({ "api-key": "API_KEY" });
      mockSecrets({ "api-key": "from-vault" });

      await loadSecrets({ cwd: tmpDir });

      expect(process.env.API_KEY).toBe("");
    });

    test("skips gracefully when not configured", async () => {
      isConfiguredSpy.mockResolvedValue(false);
      writeManifest({ "api-key": "API_KEY" });
      mockSecrets({ "api-key": "secret" });

      await loadSecrets({ cwd: tmpDir });

      expect(process.env.API_KEY).toBeUndefined();
    });

    test("handles missing manifest gracefully", async () => {
      await loadSecrets({ cwd: tmpDir });
      expect(process.env.API_KEY).toBeUndefined();
    });

    test("handles partial vault (some secrets missing)", async () => {
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "secret-123" });

      await loadSecrets({ cwd: tmpDir });

      expect(process.env.API_KEY).toBe("secret-123");
      expect(process.env.BOT_TOKEN).toBeUndefined();
    });
  });

  describe("listKeys", () => {
    test("returns status for each secret", async () => {
      writeManifest({ "api-key": "API_KEY", "bot-token": "BOT_TOKEN" });
      mockSecrets({ "api-key": "exists" });

      const keys = await listKeys({ cwd: tmpDir });

      expect(keys).toEqual([
        { key: "api-key", envVar: "API_KEY", exists: true },
        { key: "bot-token", envVar: "BOT_TOKEN", exists: false },
      ]);
    });

    test("returns empty array for empty manifest", async () => {
      const keys = await listKeys({ cwd: tmpDir });
      expect(keys).toEqual([]);
    });
  });

  describe("getSecret", () => {
    test("returns decrypted value", async () => {
      mockSecrets({ "api-key": "my-secret" });
      const value = await getSecret("api-key", { cwd: tmpDir });
      expect(value).toBe("my-secret");
    });

    test("returns null for missing secret", async () => {
      const value = await getSecret("nonexistent", { cwd: tmpDir });
      expect(value).toBeNull();
    });
  });

  describe("isConfigured", () => {
    test("delegates to gpg module", async () => {
      expect(await isConfigured()).toBe(true);
      expect(isConfiguredSpy).toHaveBeenCalled();
    });
  });
});
