#!/usr/bin/env bun
import { parseArgs } from "util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "readline";
import { loadManifest, saveManifest } from "./manifest";
import { isPassAvailable, isConfigured, decrypt } from "./gpg";
import { keyToEnvVar, getVaultDir, getManifestPath, validateKey } from "./utils";
import { listKeys } from "./vault";

// --- Helpers ---

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function vaultEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, PASSWORD_STORE_DIR: getVaultDir(cwd), ...extra };
}

async function passInsert(key: string, value: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(
    ["sh", "-c", `printf '%s\\n' "$_FIO_SECRET" | pass insert --force --multiline "${key}"`],
    {
      env: vaultEnv(cwd, { _FIO_SECRET: value }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code === 0) return { ok: true };
  const stderr = await new Response(proc.stderr).text();
  return { ok: false, error: stderr.trim() || "unknown error" };
}

// --- Commands ---

async function cmdInit(cwd: string) {
  if (!(await isPassAvailable())) {
    console.error("pass is not installed. Install with: brew install pass (macOS) or apt install pass (Linux)");
    process.exit(1);
  }

  const vaultDir = getVaultDir(cwd);
  const gpgIdFile = join(vaultDir, ".gpg-id");
  const vaultExists = existsSync(gpgIdFile);

  let email: string;

  if (vaultExists) {
    email = (await readFile(gpgIdFile, "utf-8")).trim();
    console.log(`Vault exists (Key: ${email}). Secrets will be overwritten.\n`);
  } else {
    console.log("1/3  Generate GPG key...\n");
    const name = (await prompt("  Name (Enter = Vault): ")) || "Vault";
    email = (await prompt("  Email (Enter = vault@project): ")) || "vault@project";
    const passphrase = await prompt("  Passphrase (remember! -> password manager): ");

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
      env: vaultEnv(cwd),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });

    if ((await initProc.exited) !== 0) {
      const stderr = await new Response(initProc.stderr).text();
      console.error(stderr.trim());
      process.exit(1);
    }
    console.log(`  Vault created in: ${vaultDir}`);

    console.log("\n3/3  Export GPG private key...");
    const keyFile = join(vaultDir, "vault.key");
    const exportProc = Bun.spawn(
      ["gpg", "--batch", "--yes", "--export-secret-keys", "--armor", email],
      { stdout: "pipe", stderr: "pipe" },
    );

    if ((await exportProc.exited) === 0) {
      const keyData = await new Response(exportProc.stdout).arrayBuffer();
      if (keyData.byteLength > 0) {
        writeFileSync(keyFile, Buffer.from(keyData));
        console.log(`  Key exported: ${keyFile}`);
      }
    } else {
      console.warn("  Warning: Key export failed. Manual:");
      console.warn(`  gpg --export-secret-keys --armor ${email} > ${keyFile}`);
    }
  }

  // Store secrets from manifest
  const manifest = await loadManifest(cwd);
  if (Object.keys(manifest).length > 0) {
    console.log("\nStore secrets (empty input skips):\n");
    for (const [key, envVar] of Object.entries(manifest)) {
      const value = await prompt(`  ${envVar} (${key}): `);
      if (!value) {
        console.log(`    -> skipped`);
        continue;
      }
      const { ok, error } = await passInsert(key, value, cwd);
      console.log(ok ? `    -> stored` : `    -> Error: ${error}`);
    }
  }

  console.log("\nDone!");
  if (!vaultExists) {
    console.log("Next steps:");
    console.log("  1. git add vault/ && git commit -m 'feat: vault with encrypted secrets'");
    console.log("  2. Store passphrase in your password manager");
  }
}

async function cmdSet(key: string, envVar: string | undefined, cwd: string) {
  if (!(await isPassAvailable())) {
    console.error("pass is not installed. Install with: brew install pass (macOS) or apt install pass (Linux)");
    process.exit(1);
  }

  const resolvedEnvVar = envVar ?? keyToEnvVar(key);
  const manifest = await loadManifest(cwd);
  const isUpdate = key in manifest;
  manifest[key] = resolvedEnvVar;
  await saveManifest(manifest, cwd);

  console.log(`${isUpdate ? "Updated" : "Added"}: ${key} -> ${resolvedEnvVar}`);

  const value = await prompt(`  Value for ${resolvedEnvVar}: `);
  if (!value) {
    console.log("  No value entered - only manifest updated.");
    return;
  }

  const { ok, error } = await passInsert(key, value, cwd);
  console.log(ok ? `  -> stored` : `  -> Error: ${error}`);
}

async function cmdRemove(key: string, cwd: string) {
  const manifest = await loadManifest(cwd);
  if (!(key in manifest)) {
    console.error(`Key "${key}" not found in manifest.json.`);
    process.exit(1);
  }

  const envVar = manifest[key];
  delete manifest[key];
  await saveManifest(manifest, cwd);
  console.log(`Manifest: ${key} -> ${envVar} removed`);

  if (await isPassAvailable()) {
    const proc = Bun.spawn(["pass", "rm", "--force", key], {
      env: vaultEnv(cwd),
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

async function cmdStatus(cwd: string) {
  if (!(await isConfigured())) {
    console.log("Vault not configured. Run: fio-vault init");
    return;
  }

  console.log("Vault Status:\n");
  const keys = await listKeys({ cwd });
  for (const { key, envVar, exists } of keys) {
    const status = exists ? "+" : "-";
    console.log(`  ${status}  ${key}  ->  ${envVar}`);
  }

  const found = keys.filter((k) => k.exists).length;
  console.log(`\n${found}/${keys.length} secrets available.`);
}

async function cmdOnboard(cwd: string) {
  const vaultDir = getVaultDir(cwd);
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
  const keys = await listKeys({ cwd });
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
  --cwd <path>         Project root directory (default: cwd)
  --help               Show this help`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    cwd: { type: "string", default: process.cwd() },
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
const command = positionals[0];

switch (command) {
  case "init":
    await cmdInit(cwd);
    break;
  case "set":
    if (!positionals[1]) {
      console.error("Usage: fio-vault set <key> [ENV_VAR]");
      process.exit(1);
    }
    validateKey(positionals[1]);
    await cmdSet(positionals[1], positionals[2], cwd);
    break;
  case "remove":
    if (!positionals[1]) {
      console.error("Usage: fio-vault remove <key>");
      process.exit(1);
    }
    validateKey(positionals[1]);
    await cmdRemove(positionals[1], cwd);
    break;
  case "status":
    await cmdStatus(cwd);
    break;
  case "onboard":
    await cmdOnboard(cwd);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(USAGE);
    process.exit(1);
}
