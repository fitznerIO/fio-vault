import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest, saveManifest } from "../manifest";

describe("manifest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fio-vault-test-"));
    mkdirSync(join(tmpDir, "vault"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadManifest", () => {
    test("returns empty object when manifest missing", async () => {
      const result = await loadManifest(tmpDir);
      expect(result).toEqual({});
    });

    test("reads manifest.json from vault directory", async () => {
      const manifest = { "api-key": "API_KEY", "bot-token": "BOT_TOKEN" };
      writeFileSync(join(tmpDir, "vault", "manifest.json"), JSON.stringify(manifest));

      const result = await loadManifest(tmpDir);
      expect(result).toEqual(manifest);
    });

    test("returns empty object on invalid JSON", async () => {
      writeFileSync(join(tmpDir, "vault", "manifest.json"), "not json");

      const result = await loadManifest(tmpDir);
      expect(result).toEqual({});
    });
  });

  describe("saveManifest", () => {
    test("writes manifest.json atomically", async () => {
      const manifest = { "my-secret": "MY_SECRET" };
      await saveManifest(manifest, tmpDir);

      const result = await loadManifest(tmpDir);
      expect(result).toEqual(manifest);
    });

    test("overwrites existing manifest", async () => {
      await saveManifest({ old: "OLD" }, tmpDir);
      await saveManifest({ new: "NEW" }, tmpDir);

      const result = await loadManifest(tmpDir);
      expect(result).toEqual({ new: "NEW" });
    });
  });
});
