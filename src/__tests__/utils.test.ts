import { describe, test, expect } from "bun:test";
import { keyToEnvVar, getVaultDir, getManifestPath, getGpgFilePath } from "../utils";

describe("keyToEnvVar", () => {
  test("converts kebab-case to SCREAMING_SNAKE_CASE", () => {
    expect(keyToEnvVar("openai-api-key")).toBe("OPENAI_API_KEY");
    expect(keyToEnvVar("telegram-bot-token")).toBe("TELEGRAM_BOT_TOKEN");
    expect(keyToEnvVar("simple")).toBe("SIMPLE");
    expect(keyToEnvVar("a-b-c")).toBe("A_B_C");
  });
});

describe("getVaultDir", () => {
  test("returns vault/ under given cwd", () => {
    expect(getVaultDir("/my/project")).toBe("/my/project/vault");
  });
});

describe("getManifestPath", () => {
  test("returns manifest.json inside vault dir", () => {
    expect(getManifestPath("/my/project")).toBe("/my/project/vault/manifest.json");
  });
});

describe("getGpgFilePath", () => {
  test("returns .gpg file path for key", () => {
    expect(getGpgFilePath("api-key", "/my/project")).toBe("/my/project/vault/api-key.gpg");
  });
});
