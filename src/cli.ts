#!/usr/bin/env bun
import { parseArgs } from "util";
import { existsSync, mkdirSync, chmodSync, appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createInterface } from "readline";
import { loadManifest, saveManifest } from "./manifest";
import { isPassAvailable, isConfigured } from "./gpg";
import { keyToEnvVar, getVaultDir, getGlobalVaultDir, validateKey } from "./utils";
import { listKeys } from "./vault";

// --- Helpers ---

// Single shared readline interface — avoids terminal mode issues (e.g. @ not typeable)
// when opening/closing multiple interfaces on the same stdin.
let _rl: ReturnType<typeof createInterface> | null = null;
function getReadline() {
  if (!_rl) {
    _rl = createInterface({ input: process.stdin, output: process.stdout });
    _rl.on("close", () => { _rl = null; });
  }
  return _rl;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    getReadline().question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** Close the readline interface so the process can exit cleanly. */
function closePrompt() {
  if (_rl) { _rl.close(); _rl = null; }
}

function vaultEnv(vaultDir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, PASSWORD_STORE_DIR: vaultDir, ...extra };
}

async function passInsert(key: string, value: string, vaultDir: string): Promise<{ ok: boolean; error?: string }> {
  // Pass value via stdin — no shell involved, no injection surface
  const proc = Bun.spawn(
    ["pass", "insert", "--force", "--multiline", key],
    {
      env: vaultEnv(vaultDir),
      stdin: new TextEncoder().encode(value + "\n"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code === 0) return { ok: true };
  const stderr = await new Response(proc.stderr).text();
  return { ok: false, error: stderr.trim() || "unknown error" };
}

/** Check and configure pinentry-mac on macOS for GUI passphrase prompts. */
async function ensurePinentryMac(): Promise<void> {
  if (platform() !== "darwin") return;

  // Find pinentry-mac binary
  const candidates = ["/opt/homebrew/bin/pinentry-mac", "/usr/local/bin/pinentry-mac"];
  const pinentryPath = candidates.find((p) => existsSync(p));

  if (!pinentryPath) {
    console.warn("\n  Warning: pinentry-mac not found.");
    console.warn("  Without it, GPG cannot prompt for passphrases outside a terminal (IDEs, CI, GUI apps).");
    console.warn("  Install with: brew install pinentry-mac");
    return;
  }

  // Check gpg-agent.conf
  const gnupgDir = join(homedir(), ".gnupg");
  const agentConf = join(gnupgDir, "gpg-agent.conf");
  const expectedLine = `pinentry-program ${pinentryPath}`;

  if (existsSync(agentConf)) {
    const content = await readFile(agentConf, "utf-8");
    if (content.includes("pinentry-program")) {
      if (content.includes(pinentryPath)) return; // already configured
      console.warn(`\n  Warning: ${agentConf} has a different pinentry-program configured.`);
      console.warn(`  For fio-vault to work in IDEs/GUIs, set: ${expectedLine}`);
      return;
    }
  }

  // Auto-configure
  mkdirSync(gnupgDir, { recursive: true });
  appendFileSync(agentConf, `\n${expectedLine}\n`);
  console.log(`\n  Configured pinentry-mac in ${agentConf}`);

  // Restart gpg-agent to pick up the change
  const kill = Bun.spawn(["gpgconf", "--kill", "gpg-agent"], { stdout: "pipe", stderr: "pipe" });
  await kill.exited;
  console.log("  Restarted gpg-agent");
}

/** Resolve the effective vault directory based on --global flag. */
function resolveVaultDir(cwd: string, isGlobal: boolean): string {
  return isGlobal ? getVaultDir(getGlobalVaultDir()) : getVaultDir(cwd);
}

// --- Commands ---

async function cmdInit(cwd: string, isGlobal: boolean) {
  if (!(await isPassAvailable())) {
    console.error("pass is not installed. Install with: brew install pass (macOS) or apt install pass (Linux)");
    process.exit(1);
  }

  const vaultDir = resolveVaultDir(cwd, isGlobal);
  const gpgIdFile = join(vaultDir, ".gpg-id");
  const vaultExists = existsSync(gpgIdFile);
  const label = isGlobal ? "Global vault" : "Vault";

  let email: string;

  if (vaultExists) {
    email = (await readFile(gpgIdFile, "utf-8")).trim();
    console.log(`${label} exists (Key: ${email}). Secrets will be overwritten.\n`);
  } else {
    console.log("1/3  Generate GPG key...\n");
    // Sanitize GPG batch input: strip newlines (parameter injection) and leading %
    // (GPG batch directives like %commit, %no-protection, %ask-passphrase).
    const sanitizeGpgInput = (s: string) => s.replace(/[\r\n]/g, "").replace(/^%/, "");
    const name = sanitizeGpgInput((await prompt("  Name (Enter = Vault): ")) || "Vault");
    email = sanitizeGpgInput((await prompt("  Email (Enter = vault@project): ")) || "vault@project");
    const passphrase = sanitizeGpgInput(await prompt("  Passphrase (remember! -> password manager): "));

    if (!passphrase) {
      console.error("\n  Passphrase is required.");
      process.exit(1);
    }

    const genKey = Bun.spawn(
      ["gpg", "--batch", "--gen-key"],
      {
        stdin: new TextEncoder().encode(
          `Key-Type: RSA\nKey-Length: 4096\nSubkey-Type: RSA\nSubkey-Length: 4096\nName-Real: ${name}\nName-Email: ${email}\nPassphrase: ${passphrase}\nExpire-Date: 0\n%commit\n`,
        ),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if ((await genKey.exited) !== 0) {
      const stderr = await new Response(genKey.stderr).text();
      console.error(`  Error: ${stderr.trim()}`);
      process.exit(1);
    }
    console.log(`  GPG key created for ${email}`);

    mkdirSync(vaultDir, { recursive: true });
    console.log("\n2/3  Initialize vault...");
    const initProc = Bun.spawn(["pass", "init", email], {
      env: vaultEnv(vaultDir),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });

    if ((await initProc.exited) !== 0) {
      const stderr = await new Response(initProc.stderr).text();
      console.error(stderr.trim());
      process.exit(1);
    }
    console.log(`  ${label} created in: ${vaultDir}`);

    console.log("\n3/3  Export GPG private key...");
    const keyFile = join(vaultDir, "vault.key");
    const exportProc = Bun.spawn(
      ["gpg", "--batch", "--yes", "--pinentry-mode", "loopback",
       "--passphrase-fd", "0", "--export-secret-keys", "--armor", email],
      // GPG expects a newline-terminated passphrase on fd 0
      { stdin: new TextEncoder().encode(passphrase + "\n"), stdout: "pipe", stderr: "pipe" },
    );

    if ((await exportProc.exited) === 0) {
      const keyData = await new Response(exportProc.stdout).arrayBuffer();
      if (keyData.byteLength > 0) {
        await Bun.write(keyFile, keyData);
        chmodSync(keyFile, 0o600);
        console.log(`  Key exported: ${keyFile}`);
      } else {
        console.warn("  Warning: Key export produced empty output. Run manually:");
        console.warn(`  gpg --export-secret-keys --armor ${email} > "${keyFile}"`);
      }
    } else {
      console.warn("  Warning: Key export failed. Run manually:");
      console.warn(`  gpg --export-secret-keys --armor ${email} > "${keyFile}"`);
    }

    await ensurePinentryMac();
  }

  // Store secrets from manifest
  const manifestCwd = isGlobal ? getGlobalVaultDir() : cwd;
  const manifest = await loadManifest(manifestCwd);
  if (Object.keys(manifest).length > 0) {
    console.log("\nStore secrets (empty input skips):\n");
    for (const [key, envVar] of Object.entries(manifest)) {
      const value = await prompt(`  ${envVar} (${key}): `);
      if (!value) {
        console.log(`    -> skipped`);
        continue;
      }
      const { ok, error } = await passInsert(key, value, vaultDir);
      console.log(ok ? `    -> stored` : `    -> Error: ${error}`);
    }
  }

  console.log("\nDone!");
  if (!vaultExists && !isGlobal) {
    console.log("Next steps:");
    console.log("  1. git add vault/ && git commit -m 'feat: vault with encrypted secrets'");
    console.log("  2. Store passphrase in your password manager");
  }
}

async function cmdSet(key: string, envVar: string | undefined, cwd: string, isGlobal: boolean) {
  if (!(await isPassAvailable())) {
    console.error("pass is not installed. Install with: brew install pass (macOS) or apt install pass (Linux)");
    process.exit(1);
  }

  const vaultDir = resolveVaultDir(cwd, isGlobal);
  const manifestCwd = isGlobal ? getGlobalVaultDir() : cwd;

  // Ensure global vault directory exists
  if (isGlobal && !existsSync(vaultDir)) {
    mkdirSync(vaultDir, { recursive: true });
  }

  const resolvedEnvVar = envVar ?? keyToEnvVar(key);
  const manifest = await loadManifest(manifestCwd);
  const isUpdate = key in manifest;
  manifest[key] = resolvedEnvVar;
  await saveManifest(manifest, manifestCwd);

  const label = isGlobal ? " (global)" : "";
  console.log(`${isUpdate ? "Updated" : "Added"}${label}: ${key} -> ${resolvedEnvVar}`);

  const value = await prompt(`  Value for ${resolvedEnvVar}: `);
  if (!value) {
    console.log("  No value entered - only manifest updated.");
    return;
  }

  const { ok, error } = await passInsert(key, value, vaultDir);
  console.log(ok ? `  -> stored` : `  -> Error: ${error}`);
}

async function cmdRemove(key: string, cwd: string, isGlobal: boolean) {
  const manifestCwd = isGlobal ? getGlobalVaultDir() : cwd;
  const vaultDir = resolveVaultDir(cwd, isGlobal);
  const manifest = await loadManifest(manifestCwd);

  if (!(key in manifest)) {
    const label = isGlobal ? "global " : "";
    console.error(`Key "${key}" not found in ${label}manifest.json.`);
    process.exit(1);
  }

  const envVar = manifest[key];
  delete manifest[key];
  await saveManifest(manifest, manifestCwd);
  console.log(`Manifest: ${key} -> ${envVar} removed`);

  if (await isPassAvailable()) {
    const proc = Bun.spawn(["pass", "rm", "--force", key], {
      env: vaultEnv(vaultDir),
      stdout: "pipe",
      stderr: "pipe",
    });

    if ((await proc.exited) === 0) {
      console.log(`Vault: ${key}.gpg deleted`);
    } else {
      const stderr = await new Response(proc.stderr).text();
      if (stderr.trim()) console.warn(`Vault: ${stderr.trim()}`);
    }
  }
}

async function cmdStatus(cwd: string, isGlobal: boolean) {
  if (!(await isConfigured())) {
    console.log("Vault not configured. Run: fio-vault init");
    return;
  }

  console.log("Vault Status:\n");
  const effectiveCwd = isGlobal ? getGlobalVaultDir() : cwd;
  const keys = await listKeys({ cwd: effectiveCwd, global: !isGlobal });
  for (const { key, envVar, exists, source } of keys) {
    const status = exists ? "+" : "-";
    const tag = source === "global" ? " [global]" : "";
    console.log(`  ${status}  ${key}  ->  ${envVar}${tag}`);
  }

  const found = keys.filter((k) => k.exists).length;
  console.log(`\n${found}/${keys.length} secrets available.`);
}

async function cmdOnboard(cwd: string, isGlobal: boolean) {
  const vaultDir = resolveVaultDir(cwd, isGlobal);
  const keyFile = join(vaultDir, "vault.key");

  if (!existsSync(keyFile)) {
    console.error(`No GPG key found: ${keyFile}`);
    console.error("Run 'fio-vault init' first.");
    process.exit(1);
  }

  console.log("1/2  Import GPG key...");
  const importProc = Bun.spawn(["gpg", "--batch", "--import", keyFile], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  if ((await importProc.exited) !== 0) {
    const stderr = await new Response(importProc.stderr).text();
    if (!stderr.includes("not changed")) {
      console.error(`  Error: ${stderr.trim()}`);
      process.exit(1);
    }
  }
  console.log("  GPG key imported");

  console.log("\n2/2  Enter passphrase (from password manager):");
  const passphrase = await prompt("  FIO_VAULT_PASSPHRASE: ");
  if (!passphrase) {
    console.error("  No passphrase entered.");
    process.exit(1);
  }

  process.env.FIO_VAULT_PASSPHRASE = passphrase;
  const keys = await listKeys({ cwd, global: false });
  // Remove from env immediately after verification — shell config is the intended persistent store
  delete process.env.FIO_VAULT_PASSPHRASE;
  const readable = keys.filter((k) => k.exists);

  if (readable.length === 0) {
    console.error("  Decryption failed. Wrong passphrase?");
    process.exit(1);
  }

  console.log(`  ${readable.length}/${keys.length} secrets readable`);
  console.log("\nDone! Set passphrase permanently:\n");
  console.log("  1. Add to your shell config (~/.zshrc or ~/.bashrc):");
  console.log("     export FIO_VAULT_PASSPHRASE=\"<your-passphrase>\"");
  console.log("  2. Reload: source ~/.zshrc");
}

// --- Main ---

const USAGE = `fio-vault - GPG-based secret management

Commands:
  init                 Initialize vault (generate GPG key, create vault)
  set <key> [ENV_VAR]  Add or update a secret
  remove <key>         Remove a secret
  status               Show vault status
  onboard              Setup on a new machine (import GPG key)

Options:
  --global             Use global vault (~/.fio-vault/) instead of project vault
  --cwd <path>         Project root directory (default: cwd)
  --help               Show this help`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cwd: { type: "string", default: process.cwd() },
    global: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help || positionals.length === 0) {
  console.log(USAGE);
  process.exit(0);
}

const cwd = values.cwd as string;
const isGlobal = values.global as boolean;
const command = positionals[0];

switch (command) {
  case "init":
    await cmdInit(cwd, isGlobal);
    break;
  case "set":
    if (!positionals[1]) {
      console.error("Usage: fio-vault set <key> [ENV_VAR]");
      process.exit(1);
    }
    validateKey(positionals[1]);
    await cmdSet(positionals[1], positionals[2], cwd, isGlobal);
    break;
  case "remove":
    if (!positionals[1]) {
      console.error("Usage: fio-vault remove <key>");
      process.exit(1);
    }
    validateKey(positionals[1]);
    await cmdRemove(positionals[1], cwd, isGlobal);
    break;
  case "status":
    await cmdStatus(cwd, isGlobal);
    break;
  case "onboard":
    await cmdOnboard(cwd, isGlobal);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(USAGE);
    process.exit(1);
}

closePrompt();
