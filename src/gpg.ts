import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getVaultDir, getGpgFilePath, validateKey } from "./utils";

/** Check if `pass` is installed. */
export async function isPassAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "pass"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/** Check if vault can be used (pass installed OR passphrase set). */
export async function isConfigured(opts?: { passphrase?: string }): Promise<boolean> {
  const passphrase = opts?.passphrase ?? process.env.FIO_VAULT_PASSPHRASE;
  if (passphrase) return true;
  return isPassAvailable();
}

/** Check if the GPG key referenced by .gpg-id exists in the keyring. */
export async function hasGpgKey(cwd?: string): Promise<boolean> {
  try {
    const gpgIdFile = join(getVaultDir(cwd), ".gpg-id");
    if (!existsSync(gpgIdFile)) return false;
    const gpgId = (await readFile(gpgIdFile, "utf-8")).trim();
    if (!gpgId) return false;
    const proc = Bun.spawn(["gpg", "--batch", "--list-keys", gpgId], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Decrypt a single secret. Returns trimmed value or null. */
export async function decrypt(
  key: string,
  opts?: { cwd?: string; passphrase?: string },
): Promise<string | null> {
  validateKey(key);
  const cwd = opts?.cwd;
  const passphrase = opts?.passphrase ?? process.env.FIO_VAULT_PASSPHRASE;

  try {
    let proc;
    if (passphrase) {
      // Direct GPG decryption — passphrase via stdin (not visible in ps)
      const gpgFile = getGpgFilePath(key, cwd);
      if (!existsSync(gpgFile)) return null;
      proc = Bun.spawn(
        ["gpg", "--batch", "--quiet", "--yes", "--passphrase-fd", "0", "--decrypt", gpgFile],
        // GPG expects a newline-terminated passphrase on fd 0
        { stdin: new TextEncoder().encode(passphrase + "\n"), stdout: "pipe", stderr: "pipe" },
      );
    } else {
      // Standard pass show — uses gpg-agent
      const vaultDir = getVaultDir(cwd);
      proc = Bun.spawn(["pass", "show", key], {
        env: { ...process.env, PASSWORD_STORE_DIR: vaultDir },
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    const code = await proc.exited;
    if (code !== 0) return null;

    const text = await new Response(proc.stdout).text();
    return text.trim();
  } catch {
    return null;
  }
}
