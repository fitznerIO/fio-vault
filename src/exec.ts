import { existsSync } from "node:fs";
import { loadManifest } from "./manifest";
import { decrypt, isConfigured } from "./gpg";
import { getGlobalVaultDir, getGpgFilePath, getManifestPath } from "./utils";

export interface ExecOptions {
  /** Restrict injection to these manifest keys (least privilege). */
  only?: string[];
  /** Use only the global vault (~/.fio-vault/), no project/global merge. */
  global?: boolean;
  /** Project root used for vault/manifest resolution (NOT the child's cwd). */
  cwd: string;
}

type ResolveResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; error: string };

/** Ordered project-root dirs to consult: project-first, global-fallback. */
function resolveDirs(opts: ExecOptions): string[] {
  if (opts.global) return [getGlobalVaultDir()];
  const dirs = [opts.cwd];
  if (existsSync(getManifestPath(getGlobalVaultDir()))) dirs.push(getGlobalVaultDir());
  return dirs;
}

/**
 * Build the env-var map to inject into the child. Decrypts internally and never
 * returns the raw values to the caller's stdout. Distinguishes the two failure
 * modes the PRD calls out:
 *   - `.gpg` missing for a manifest entry  → warn on stderr, skip, keep going.
 *   - `.gpg` present but decryption fails   → hard error (no silent child start).
 */
export async function resolveSecrets(opts: ExecOptions): Promise<ResolveResult> {
  const dirs = resolveDirs(opts);
  const env: Record<string, string> = {}; // envVar -> value (first source wins)
  const missing = new Map<string, string>(); // envVar -> key (manifest entry, no .gpg)
  const onlySet = opts.only ? new Set(opts.only) : null;
  const matchedKeys = new Set<string>();

  for (const dir of dirs) {
    const manifest = await loadManifest(dir);
    for (const [key, envVar] of Object.entries(manifest)) {
      if (onlySet && !onlySet.has(key)) continue;
      matchedKeys.add(key);
      if (envVar in env) continue; // no-overwrite: first-resolved source wins

      const gpgFile = getGpgFilePath(key, dir);
      if (!existsSync(gpgFile)) {
        if (!missing.has(envVar)) missing.set(envVar, key);
        continue;
      }

      const value = await decrypt(key, { cwd: dir });
      if (value === null) {
        // File exists but could not be decrypted (cold gpg-agent, no passphrase,
        // no TTY). Fail loud — never print the value, only the key name.
        return {
          ok: false,
          error:
            `Failed to decrypt secret "${key}": the encrypted file exists but ` +
            `could not be decrypted.\n` +
            `  Warm up the gpg-agent (decrypt once interactively) or set ` +
            `FIO_VAULT_PASSPHRASE.`,
        };
      }
      env[envVar] = value;
      missing.delete(envVar); // resolved here, no longer "missing"
    }
  }

  // --only keys that appeared in NO manifest at all → hard error.
  if (onlySet) {
    const unmatched = [...onlySet].filter((k) => !matchedKeys.has(k));
    if (unmatched.length > 0) {
      return {
        ok: false,
        error: `Secret key(s) not found in any manifest: ${unmatched.join(", ")}`,
      };
    }
  }

  // Manifest entries whose .gpg was missing and never resolved elsewhere → warn.
  for (const [envVar, key] of missing) {
    if (!(envVar in env)) {
      console.error(`Warning: secret "${key}" (${envVar}) has no encrypted file; skipping.`);
    }
  }

  return { ok: true, env };
}

/**
 * Run `<command>` with the vault's secrets injected into its environment.
 * Decrypts internally, never emits raw secrets on exec's own stdout/stderr,
 * inherits stdin, forwards stdout/stderr, forwards signals, and passes the
 * child's exit code through.
 */
export async function runExec(childArgv: string[], opts: ExecOptions): Promise<number> {
  if (childArgv.length === 0) {
    console.error(
      "Usage: fio-vault exec [--only k1,k2] [--global] [--cwd p] -- <command> [args...]",
    );
    return 1;
  }

  // Pre-gate: the vault must be usable. If not, fail loud and do NOT start the
  // child — starting it silently without secrets is the failure mode we avoid.
  if (!(await isConfigured())) {
    console.error("Vault not configured. Run: fio-vault init");
    return 1;
  }

  const resolved = await resolveSecrets(opts);
  if (!resolved.ok) {
    console.error(resolved.error);
    return 1;
  }

  // Child env: inherit ours + injected secrets, but strip the master passphrase
  // (least privilege — it unlocks the whole vault, not just this command's keys).
  const childEnv: Record<string, string | undefined> = { ...process.env, ...resolved.env };
  delete childEnv.FIO_VAULT_PASSPHRASE;

  const proc = Bun.spawn(childArgv, {
    env: childEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  // Bun does not forward signals to spawned children — wire them through so
  // Ctrl-C / termination reaches the child. Never call process.exit ourselves;
  // await the child and pass its code through (already 128+signum on signal).
  const forward = (sig: NodeJS.Signals) => {
    try {
      proc.kill(sig);
    } catch {
      // child already gone
    }
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    return await proc.exited;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
