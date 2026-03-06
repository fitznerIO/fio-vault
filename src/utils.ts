import { homedir } from "node:os";
import { join, resolve } from "node:path";

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Validate that a key is safe (no path traversal, no special chars). */
export function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes("..")) {
    throw new Error(
      `Invalid key: "${key}". Keys must start with alphanumeric and contain only [a-zA-Z0-9._-].`,
    );
  }
}

/** Convert kebab-case key to SCREAMING_SNAKE_CASE env var name. */
export function keyToEnvVar(key: string): string {
  return key.replace(/-/g, "_").toUpperCase();
}

/** Resolve the global vault directory (~/.fio-vault/). */
export function getGlobalVaultDir(): string {
  return join(homedir(), ".fio-vault");
}

/** Resolve the vault directory for a given project root. */
export function getVaultDir(cwd: string = process.cwd()): string {
  return join(cwd, "vault");
}

/** Resolve the manifest.json path for a given project root. */
export function getManifestPath(cwd: string = process.cwd()): string {
  return join(getVaultDir(cwd), "manifest.json");
}

/** Resolve the .gpg file path for a given key. */
export function getGpgFilePath(key: string, cwd: string = process.cwd()): string {
  return join(getVaultDir(cwd), `${key}.gpg`);
}
