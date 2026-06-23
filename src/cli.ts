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
import { listKeys, getSecret } from "./vault";
import { runExec } from "./exec";

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

/**
 * Like prompt(), but suppresses the terminal echo of the typed characters while
 * keeping the prompt text visible — so secret values and passphrases never land
 * in scrollback or a screen-share. TTY-bound: with no interactive stdout there
 * is nothing to hide, so it falls back to the normal echoing prompt().
 */
function promptSecret(question: string): Promise<string> {
  if (process.stdout.isTTY !== true) return prompt(question);
  const rl = getReadline() as any;
  return new Promise((resolve) => {
    process.stdout.write(question); // print the prompt ourselves...
    const originalWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = () => {}; // ...then swallow every echo while reading
    rl.question("", (answer: string) => {
      rl._writeToOutput = originalWrite;
      process.stdout.write("\n"); // terminate the hidden input line
      resolve(answer.trim());
    });
  });
}

// Indirection so tests can stub the interactive prompts in-process (the default
// init/onboard paths are readline-driven and don't drive reliably over a pipe).
export const _prompts = { prompt, promptSecret };

/** Strip exactly one trailing newline (\n or \r\n); leave the rest raw. */
function stripOneTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
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

export async function cmdInit(cwd: string, isGlobal: boolean, noPassphrase = false) {
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
    // --no-passphrase is the unattended/headless path: skip ALL interactive prompts
    // (name, email, AND passphrase) so it never blocks without a TTY. It generates a
    // %no-protection key (private key unencrypted at rest, guarded ONLY by filesystem
    // permissions) — friction-free on a single-user VPS where an at-rest passphrase
    // adds no security. The default path below stays fully interactive and keeps the
    // passphrase mandatory.
    let name: string;
    let passphrase = "";
    if (noPassphrase) {
      name = "Vault";
      email = "vault@project";
    } else {
      name = sanitizeGpgInput((await _prompts.prompt("  Name (Enter = Vault): ")) || "Vault");
      email = sanitizeGpgInput((await _prompts.prompt("  Email (Enter = vault@project): ")) || "vault@project");
      // Passphrase: no-echo + double-entry. Compare on the SANITIZED values, since
      // the sanitized form is what becomes the real GPG passphrase (cli.ts above).
      passphrase = sanitizeGpgInput(await _prompts.promptSecret("  Passphrase (remember! -> password manager): "));

      if (!passphrase) {
        console.error("\n  Passphrase is required.");
        process.exit(1);
      }

      const confirmPassphrase = sanitizeGpgInput(await _prompts.promptSecret("  Confirm passphrase: "));
      if (passphrase !== confirmPassphrase) {
        console.error("\n  Passphrases do not match. Aborting (no key generated).");
        process.exit(1);
      }
    }

    // GPG batch directive ordering is load-bearing: %no-protection must replace the
    // Passphrase line entirely (an empty `Passphrase:` is NOT the same as no
    // protection). Everything else stays identical to the passphrase path.
    const protection = noPassphrase ? "%no-protection" : `Passphrase: ${passphrase}`;
    const genKey = Bun.spawn(
      ["gpg", "--batch", "--gen-key"],
      {
        stdin: new TextEncoder().encode(
          `Key-Type: RSA\nKey-Length: 4096\nSubkey-Type: RSA\nSubkey-Length: 4096\nName-Real: ${name}\nName-Email: ${email}\n${protection}\nExpire-Date: 0\n%commit\n`,
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
    if (noPassphrase) {
      console.warn(
        "\n  ⚠  This key has NO passphrase. It is protected ONLY by filesystem permissions.\n" +
        "     Keep vault.key out of backups and out of git. Use only on a trusted single-user host.",
      );
    }

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
    // A %no-protection key has no passphrase to supply — export without the
    // loopback/passphrase-fd plumbing. The passphrase path feeds it on fd 0.
    const exportProc = noPassphrase
      ? Bun.spawn(
          ["gpg", "--batch", "--yes", "--export-secret-keys", "--armor", email],
          { stdout: "pipe", stderr: "pipe" },
        )
      : Bun.spawn(
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
      const value = await promptSecret(`  ${envVar} (${key}): `);
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
    if (noPassphrase) {
      console.log("  2. This key has NO passphrase — keep vault.key out of git/backups;");
      console.log("     filesystem permissions (chmod 600) are the only boundary.");
    } else {
      console.log("  2. Store passphrase in your password manager");
    }
  }
}

export async function cmdSet(
  key: string,
  envVar: string | undefined,
  cwd: string,
  isGlobal: boolean,
  useStdin: boolean,
): Promise<number> {
  if (!(await isPassAvailable())) {
    console.error("pass is not installed. Install with: brew install pass (macOS) or apt install pass (Linux)");
    return 1;
  }

  const vaultDir = resolveVaultDir(cwd, isGlobal);
  const manifestCwd = isGlobal ? getGlobalVaultDir() : cwd;

  // Ensure global vault directory exists
  if (isGlobal && !existsSync(vaultDir)) {
    mkdirSync(vaultDir, { recursive: true });
  }

  const resolvedEnvVar = envVar ?? keyToEnvVar(key);
  const label = isGlobal ? " (global)" : "";

  // --stdin: read the value ONLY from stdin (history-safe, pipeable). Write the
  // manifest entry only AFTER a successful store, so an empty/aborted pipe never
  // leaves an orphaned manifest entry (silent data loss in the advertised use case).
  if (useStdin) {
    if (process.stdin.isTTY === true) {
      console.error("--stdin expects piped/redirected input, not an interactive terminal.");
      return 1;
    }
    const value = stripOneTrailingNewline(await Bun.stdin.text());
    if (value.length === 0) {
      console.error("--stdin received empty input; nothing stored, manifest unchanged.");
      return 1;
    }

    const { ok, error } = await passInsert(key, value, vaultDir);
    if (!ok) {
      console.error(`  -> Error: ${error}`);
      return 1;
    }

    const manifest = await loadManifest(manifestCwd);
    const isUpdate = key in manifest;
    manifest[key] = resolvedEnvVar;
    await saveManifest(manifest, manifestCwd);
    console.log(`${isUpdate ? "Updated" : "Added"}${label}: ${key} -> ${resolvedEnvVar} -> stored`);
    return 0;
  }

  // Interactive path: legacy semantics — manifest is updated up front, and an
  // empty value is allowed ("only manifest"). The value prompt is no-echo.
  const manifest = await loadManifest(manifestCwd);
  const isUpdate = key in manifest;
  manifest[key] = resolvedEnvVar;
  await saveManifest(manifest, manifestCwd);
  console.log(`${isUpdate ? "Updated" : "Added"}${label}: ${key} -> ${resolvedEnvVar}`);

  const value = await promptSecret(`  Value for ${resolvedEnvVar}: `);
  if (!value) {
    console.log("  No value entered - only manifest updated.");
    return 0;
  }

  const { ok, error } = await passInsert(key, value, vaultDir);
  console.log(ok ? `  -> stored` : `  -> Error: ${error}`);
  return ok ? 0 : 1;
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

async function cmdOnboard(cwd: string, isGlobal: boolean, noPassphrase = false) {
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

  // --no-passphrase: the imported key has no passphrase, so skip the passphrase
  // prompt and verify decryption directly (FIO_VAULT_PASSPHRASE not needed). We do
  // NOT auto-detect this: any decrypt-based probe consults the gpg-agent cache and
  // would false-positive a passphrase-protected key whenever the agent is warm
  // (cache TTL ~600s, and init/set warm it). The explicit flag is the only reliable,
  // honest trigger — matching `init --no-passphrase`.
  if (noPassphrase) {
    console.log("\n2/2  Verify decryption (no-passphrase key)...");
    const hadEnv = "FIO_VAULT_PASSPHRASE" in process.env;
    const prev = process.env.FIO_VAULT_PASSPHRASE;
    delete process.env.FIO_VAULT_PASSPHRASE;
    let keys;
    try {
      keys = await listKeys({ cwd, global: false });
    } finally {
      if (hadEnv) process.env.FIO_VAULT_PASSPHRASE = prev;
    }
    const readable = keys.filter((k) => k.exists);
    // No secrets yet (fresh vault) is fine — the key imported and needs no passphrase.
    console.log(`  ${readable.length}/${keys.length} secrets readable`);
    console.log("\nDone! This key has no passphrase — nothing to set in your shell.");
    console.log("  Security rests on filesystem permissions: keep vault.key out of git/backups.");
    return;
  }

  console.log("\n2/2  Enter passphrase (from password manager):");
  const passphrase = await promptSecret("  FIO_VAULT_PASSPHRASE: ");
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

export async function cmdGet(
  key: string,
  cwd: string,
  isGlobal: boolean,
  allowRaw: boolean,
): Promise<number> {
  if (!(await isConfigured())) {
    console.error("Vault not configured. Run: fio-vault init");
    return 1;
  }

  // Guard: never emit the raw secret unless stdout is an interactive TTY (a human
  // at a terminal) or the caller explicitly opts in with --allow-raw. A non-TTY
  // stdout means subshell capture `$(…)`, a pipe, a redirect, an agent or CI — the
  // exact contexts where an accidentally-printed key leaks into a transcript/log.
  if (!allowRaw && process.stdout.isTTY !== true) {
    console.error(
      `Refusing to print raw secret "${key}" to a non-interactive stdout.\n` +
        `  For agents/scripts, run the command WITH the secret instead of reading it:\n` +
        `    fio-vault exec --only ${key} -- <command>\n` +
        `  For legitimate cross-language/CI use, force raw output with --allow-raw.`,
    );
    return 3;
  }

  const effectiveCwd = isGlobal ? getGlobalVaultDir() : cwd;
  const value = await getSecret(key, { cwd: effectiveCwd, global: !isGlobal });
  if (value === null) {
    console.error(`Secret "${key}" not found or decryption failed.`);
    return 1;
  }
  process.stdout.write(value);
  return 0;
}

// --- Main ---

const USAGE = `fio-vault - GPG-based secret management

Commands:
  init                 Initialize vault (generate GPG key, create vault)
  set <key> [ENV_VAR]  Add or update a secret (no-echo prompt; or --stdin)
  get <key>            Print a decrypted secret (interactive TTY / --allow-raw only)
  exec -- <cmd...>     Run a command with the vault's secrets in its environment
  remove <key>         Remove a secret
  status               Show vault status
  onboard              Setup on a new machine (import GPG key)

Options:
  --global             Use global vault (~/.fio-vault/) instead of project vault
  --cwd <path>         Project root directory (default: cwd)
  --only <k1,k2>       exec: inject only these manifest keys (least privilege)
  --stdin              set: read the value from stdin (history-safe, no prompt)
  --allow-raw          Allow 'get' to print a raw secret to a non-TTY stdout
  --no-passphrase      init/onboard: unattended key with NO passphrase (filesystem
                       permissions are the only boundary — single-user hosts only)
  --help               Show this help`;

if (import.meta.main) {
  try {
  const rawArgs = Bun.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: {
      cwd: { type: "string", default: process.cwd() },
      global: { type: "boolean", default: false },
      only: { type: "string" },
      stdin: { type: "boolean", default: false },
      "allow-raw": { type: "boolean", default: false },
      "no-passphrase": { type: "boolean", default: false },
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
  const allowRaw = values["allow-raw"] as boolean;
  const noPassphrase = values["no-passphrase"] as boolean;
  const command = positionals[0];

  switch (command) {
    case "init":
      await cmdInit(cwd, isGlobal, noPassphrase);
      break;
    case "get":
      if (!positionals[1]) {
        console.error("Usage: fio-vault get <key>");
        process.exit(1);
      }
      validateKey(positionals[1]);
      process.exit(await cmdGet(positionals[1], cwd, isGlobal, allowRaw));
      break;
    case "exec": {
      // `--` is the option terminator: everything after it lands verbatim in
      // positionals (child argv = positionals after the command). Require it
      // explicitly so we never mistake a missing separator for an empty child.
      if (!rawArgs.includes("--")) {
        console.error(
          "Usage: fio-vault exec [--only k1,k2] [--global] [--cwd p] -- <command> [args...]",
        );
        process.exit(1);
      }
      const childArgv = positionals.slice(1);
      const only = values.only
        ? (values.only as string).split(",").map((k) => k.trim()).filter(Boolean)
        : undefined;
      only?.forEach(validateKey);
      process.exit(await runExec(childArgv, { only, global: isGlobal, cwd }));
      break;
    }
    case "set":
      if (!positionals[1]) {
        console.error("Usage: fio-vault set <key> [ENV_VAR]");
        process.exit(1);
      }
      validateKey(positionals[1]);
      process.exit(await cmdSet(positionals[1], positionals[2], cwd, isGlobal, values.stdin as boolean));
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
      await cmdOnboard(cwd, isGlobal, noPassphrase);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }

  closePrompt();
  } catch (err) {
    // Surface argument-parse errors (unknown/ambiguous flags) and key-validation
    // failures as a clean one-line message + exit 1, never a raw stack trace.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
