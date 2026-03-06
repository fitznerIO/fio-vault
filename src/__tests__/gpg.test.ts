import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPassAvailable, isConfigured, decrypt } from "../gpg";

describe("gpg", () => {
  let savedPassphrase: string | undefined;

  beforeEach(() => {
    savedPassphrase = process.env.FIO_VAULT_PASSPHRASE;
    delete process.env.FIO_VAULT_PASSPHRASE;
  });

  afterEach(() => {
    if (savedPassphrase !== undefined) {
      process.env.FIO_VAULT_PASSPHRASE = savedPassphrase;
    } else {
      delete process.env.FIO_VAULT_PASSPHRASE;
    }
  });

  describe("isConfigured", () => {
    test("returns true when passphrase is provided", async () => {
      expect(await isConfigured({ passphrase: "test" })).toBe(true);
    });

    test("returns true when FIO_VAULT_PASSPHRASE env var is set", async () => {
      process.env.FIO_VAULT_PASSPHRASE = "from-env";
      expect(await isConfigured()).toBe(true);
    });
  });

  describe("decrypt", () => {
    test("returns null for non-existent gpg file", async () => {
      const result = await decrypt("nonexistent", {
        cwd: "/tmp/no-such-dir",
        passphrase: "test",
      });
      expect(result).toBeNull();
    });
  });
});
