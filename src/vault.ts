import type { VaultOptions, KeyStatus } from "./types";
import { loadManifest } from "./manifest";
import { decrypt, isPassAvailable, isConfigured as gpgIsConfigured } from "./gpg";

/** Check if vault can be used. */
export async function isConfigured(opts?: VaultOptions): Promise<boolean> {
  return gpgIsConfigured({ passphrase: opts?.passphrase });
}

/**
 * Load all secrets from vault into process.env.
 * Only sets env vars that are not already defined (no-overwrite).
 * Gracefully skips if vault is not configured.
 */
export async function loadSecrets(opts?: VaultOptions): Promise<void> {
  const cwd = opts?.cwd;
  const passphrase = opts?.passphrase;

  if (!(await gpgIsConfigured({ passphrase }))) return;

  const manifest = await loadManifest(cwd);
  for (const [key, envVar] of Object.entries(manifest)) {
    if (process.env[envVar] !== undefined) continue;

    const value = await decrypt(key, { cwd, passphrase });
    if (value) {
      process.env[envVar] = value;
    }
  }
}

/** List all registered secrets with their status. */
export async function listKeys(opts?: VaultOptions): Promise<KeyStatus[]> {
  const cwd = opts?.cwd;
  const passphrase = opts?.passphrase;
  const manifest = await loadManifest(cwd);

  const results: KeyStatus[] = [];
  for (const [key, envVar] of Object.entries(manifest)) {
    const value = await decrypt(key, { cwd, passphrase });
    results.push({ key, envVar, exists: value !== null });
  }
  return results;
}

/** Get a single decrypted secret by key. Returns null if not found. */
export async function getSecret(key: string, opts?: VaultOptions): Promise<string | null> {
  return decrypt(key, { cwd: opts?.cwd, passphrase: opts?.passphrase });
}
