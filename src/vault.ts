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

/**
 * Load all secrets from vault into process.env.
 * Loads project vault first, then global vault as fallback (no-overwrite).
 * Gracefully skips if vault is not configured.
 */
export async function loadSecrets(opts?: VaultOptions): Promise<void> {
  const passphrase = opts?.passphrase;
  const includeGlobal = opts?.global !== false;

  if (!(await gpgIsConfigured({ passphrase }))) return;

  // Phase 1: Project vault (higher priority)
  const projectManifest = await loadManifest(opts?.cwd);
  for (const [key, envVar] of Object.entries(projectManifest)) {
    if (process.env[envVar] !== undefined) continue;
    const value = await decrypt(key, { cwd: opts?.cwd, passphrase });
    if (value) {
      process.env[envVar] = value;
    }
  }

  // Phase 2: Global vault (fallback for missing env vars)
  if (includeGlobal && hasGlobalVault()) {
    const globalDir = getGlobalVaultDir();
    const globalManifest = await loadManifest(globalDir);
    for (const [key, envVar] of Object.entries(globalManifest)) {
      if (process.env[envVar] !== undefined) continue;
      const value = await decrypt(key, { cwd: globalDir, passphrase });
      if (value) {
        process.env[envVar] = value;
      }
    }
  }
}

/** List all registered secrets with their status from both vaults. */
export async function listKeys(opts?: VaultOptions): Promise<KeyStatus[]> {
  const passphrase = opts?.passphrase;
  const includeGlobal = opts?.global !== false;
  const results: KeyStatus[] = [];
  const seen = new Set<string>();

  // Project vault first
  const projectManifest = await loadManifest(opts?.cwd);
  for (const [key, envVar] of Object.entries(projectManifest)) {
    const value = await decrypt(key, { cwd: opts?.cwd, passphrase });
    results.push({ key, envVar, exists: value !== null, source: "project" });
    seen.add(envVar);
  }

  // Global vault (skip env vars already covered by project)
  if (includeGlobal && hasGlobalVault()) {
    const globalDir = getGlobalVaultDir();
    const globalManifest = await loadManifest(globalDir);
    for (const [key, envVar] of Object.entries(globalManifest)) {
      if (seen.has(envVar)) continue;
      const value = await decrypt(key, { cwd: globalDir, passphrase });
      results.push({ key, envVar, exists: value !== null, source: "global" });
      seen.add(envVar);
    }
  }

  return results;
}

/** Get a single decrypted secret by key. Checks project vault first, then global. */
export async function getSecret(key: string, opts?: VaultOptions): Promise<string | null> {
  const passphrase = opts?.passphrase;
  const includeGlobal = opts?.global !== false;

  // Try project vault first
  const value = await decrypt(key, { cwd: opts?.cwd, passphrase });
  if (value !== null) return value;

  // Fallback to global vault
  if (includeGlobal && hasGlobalVault()) {
    return decrypt(key, { cwd: getGlobalVaultDir(), passphrase });
  }

  return null;
}
