import { existsSync } from "node:fs";
import type { VaultOptions, KeyStatus } from "./types";
import { loadManifest } from "./manifest";
import { decrypt, isConfigured as gpgIsConfigured } from "./gpg";
import { getGlobalVaultDir, getManifestPath } from "./utils";

/** Check if vault can be used. */
export async function isConfigured(opts?: VaultOptions): Promise<boolean> {
  return gpgIsConfigured({ passphrase: opts?.passphrase });
}

/** Check if the global vault exists (~/.fio-vault/manifest.json). */
function hasGlobalVault(): boolean {
  return existsSync(getManifestPath(getGlobalVaultDir()));
}

/** Resolve the ordered list of vault dirs to iterate (project-first, global-fallback). */
function resolveVaultDirs(
  opts: VaultOptions | undefined,
): Array<{ dir: string | undefined; source: "project" | "global" }> {
  const dirs: Array<{ dir: string | undefined; source: "project" | "global" }> = [
    { dir: opts?.cwd, source: "project" },
  ];
  if (opts?.global !== false && hasGlobalVault()) {
    dirs.push({ dir: getGlobalVaultDir(), source: "global" });
  }
  return dirs;
}

/**
 * Load all secrets from vault into process.env.
 * Loads project vault first, then global vault as fallback (no-overwrite).
 * Gracefully skips if vault is not configured.
 */
export async function loadSecrets(opts?: VaultOptions): Promise<void> {
  const passphrase = opts?.passphrase;
  if (!(await gpgIsConfigured({ passphrase }))) return;

  for (const { dir } of await resolveVaultDirs(opts)) {
    const manifest = await loadManifest(dir);
    for (const [key, envVar] of Object.entries(manifest)) {
      if (process.env[envVar] !== undefined) continue;
      const value = await decrypt(key, { cwd: dir, passphrase });
      if (value) process.env[envVar] = value;
    }
  }
}

/** List all registered secrets with their status from both vaults. */
export async function listKeys(opts?: VaultOptions): Promise<KeyStatus[]> {
  const passphrase = opts?.passphrase;
  const results: KeyStatus[] = [];
  const seen = new Set<string>();

  for (const { dir, source } of await resolveVaultDirs(opts)) {
    const manifest = await loadManifest(dir);
    for (const [key, envVar] of Object.entries(manifest)) {
      if (seen.has(envVar)) continue;
      const value = await decrypt(key, { cwd: dir, passphrase });
      results.push({ key, envVar, exists: value !== null, source });
      seen.add(envVar);
    }
  }

  return results;
}

/** Get a single decrypted secret by key. Checks project vault first, then global. */
export async function getSecret(key: string, opts?: VaultOptions): Promise<string | null> {
  const passphrase = opts?.passphrase;

  for (const { dir } of resolveVaultDirs(opts)) {
    const value = await decrypt(key, { cwd: dir, passphrase });
    if (value !== null) return value;
  }

  return null;
}
