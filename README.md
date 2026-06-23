# fio-vault

GPG-based secret management for Bun projects. Encrypt secrets in your repo with GPG/pass, load them into `process.env` at runtime. Supports both project-local and global vaults.

## Install

```bash
# As project dependency (library API)
bun add github:fitznerIO/fio-vault

# Global CLI (for managing global + project vaults from anywhere)
bun add -g github:fitznerIO/fio-vault
```

## Quick Start

```bash
# Initialize project vault (one-time)
fio-vault init

# Add a project secret
fio-vault set api-key API_KEY

# Add a global secret (shared across all projects)
fio-vault set --global npm-token NPM_TOKEN

# Run a command WITH the secrets injected (the safe path — see "Agents & exec")
fio-vault exec --only api-key -- bun scripts/sync.ts

# Retrieve a single secret (interactive terminal, or --allow-raw)
fio-vault get api-key --allow-raw

# Check status (shows project + global)
fio-vault status

# New machine setup
fio-vault onboard
```

## Global Vault

fio-vault supports a global vault at `~/.fio-vault/` for secrets shared across all projects (e.g. NPM tokens, API keys for dev tools).

```bash
# Initialize global vault
fio-vault init --global

# Add a global secret
fio-vault set --global npm-token NPM_TOKEN

# View all secrets (project + global)
fio-vault status
```

When `loadSecrets()` runs, it loads the **project vault first**, then fills in missing env vars from the **global vault**. Project secrets always take priority.

To disable the global vault fallback:

```typescript
await loadSecrets({ global: false });
```

## Library API

```typescript
import { loadSecrets, listKeys, getSecret, isConfigured } from "fio-vault";

// Load all secrets into process.env (project + global, no-overwrite)
await loadSecrets();

// Project vault only (skip global)
await loadSecrets({ global: false });

// With options
await loadSecrets({ cwd: "/path/to/project", passphrase: "override" });

// List secrets with status and source
const keys = await listKeys();
// [{ key: "api-key", envVar: "API_KEY", exists: true, source: "project" },
//  { key: "npm-token", envVar: "NPM_TOKEN", exists: true, source: "global" }]

// Get single secret (checks project first, then global)
const value = await getSecret("api-key");

// Check if vault is usable
const ready = await isConfigured();
```

## CLI

```
fio-vault init                 Initialize vault (GPG key + pass store)
fio-vault set <key> [ENV_VAR]  Add/update a secret (no-echo prompt, or --stdin)
fio-vault exec -- <cmd...>     Run a command with the vault's secrets injected
fio-vault get <key>            Print a secret (interactive TTY / --allow-raw only)
fio-vault remove <key>         Remove a secret
fio-vault status               Show vault status
fio-vault onboard              Setup on a new machine (import GPG key; or --no-passphrase)

Options:
  --global             Use global vault (~/.fio-vault/) instead of project vault
  --cwd <path>         Project root directory (default: cwd)
  --only <k1,k2>       exec: inject only these manifest keys (least privilege)
  --stdin              set: read the value from stdin (history-safe, no prompt)
  --allow-raw          get: allow printing a raw secret to a non-TTY stdout
  --no-passphrase      init/onboard: unattended key with NO passphrase (see below)
  --help               Show this help
```

## Agents & `exec`

fio-vault is built for a world where **LLM agents run the commands**. The threat
model is the **accidental** exposure of a secret to the agent (a subshell
capture, a debug print, a stray log, a commit), so the blessed path never hands
the raw key back.

**Run the command *with* the secret instead of reading the secret:**

```bash
# ✅ inject the secret into the child; only its output comes back
fio-vault exec --only api-key -- bun scripts/sync.ts

# ❌ never — the raw token flows through the agent's context / transcript / logs
API_KEY="$(fio-vault get api-key)" bun scripts/sync.ts
```

`exec` decrypts internally, injects the secrets into the child's environment
(stripping `FIO_VAULT_PASSPHRASE`), inherits stdin, streams only the child's
stdout/stderr, forwards signals, and passes the child's exit code through. The
raw key never appears on `exec`'s own output. Without `--only` it injects all
manifest secrets (project + global fallback); `--only k1,k2` is least-privilege.
If the vault is unusable or a secret cannot be decrypted, `exec` fails loudly and
the child never starts. See `skill/references/agent-safety.md` for the rationale.

### Entering secrets safely

Secret values are **never** CLI arguments (they would land in shell history and
`ps`). The interactive `set`/`init`/`onboard` prompts read with **no echo**. For
automation, pipe the value in history-safely with `--stdin` (one value per call):

```bash
pass show api-key | fio-vault set api-key --stdin
fio-vault set api-key --stdin < secret.txt        # chmod 600 the file
```

**Never** pass a passphrase inline (`FIO_VAULT_PASSPHRASE=… cmd` leaks via shell
history **and** `ps`) — use the no-echo prompt or set it in your shell config / a
CI secret.

## Unattended servers: `--no-passphrase`

On a headless, single-user VPS a passphrase-protected key is friction without
security: every decryption needs either a warm `gpg-agent` (interactive `pinentry`,
which hangs with no TTY) or `FIO_VAULT_PASSPHRASE` in the environment (itself a
leakable artifact). On a box where the ciphertext, the private key, and any
passphrase source all live under the same user, the at-rest passphrase only protects
an **off-box copy** of the key — not the local process.

`fio-vault init --no-passphrase` generates a `%no-protection` GPG key (the private key
is stored unencrypted) so decryption Just Works headless — no TTY, no `pinentry`, no
`FIO_VAULT_PASSPHRASE`. The security boundary becomes **filesystem permissions**.

```bash
fio-vault init --no-passphrase           # generate an unattended key (loud warning)
fio-vault onboard --no-passphrase         # import it on the server, no passphrase step
```

This is **opt-in** — the default `init`/`onboard` still requires a passphrase. When
you use it:

- `chmod 600 vault/vault.key` and `chmod 700 ~/.gnupg` — these are now the boundary.
- **Never** commit `vault.key` or include it in off-site backups (only `*.gpg` +
  `manifest.json` + `.gpg-id` belong in git). A leaked no-passphrase key is directly
  usable.
- Use only on a **trusted single-user host**. For a multi-user box, the right answer
  is a separate OS user, not a passphrase.

> **Note:** this is *not* the same as an empty passphrase. `FIO_VAULT_PASSPHRASE=""`
> is falsy and silently falls back to the `pass` path — a footgun. A `%no-protection`
> key is the honest, headless-safe choice.

### Script-side secrets (agents never name a token)

For recurring tasks, put the secret retrieval **inside a committed script** so the
agent only runs the task name and never names a key:

```ts
// scripts/sync.ts
import { loadSecrets } from "fio-vault";
await loadSecrets();                       // decrypts manifest secrets into process.env
// ... use process.env.API_KEY
```

```bash
# package.json: { "scripts": { "sync": "bun scripts/sync.ts" } }
bun run sync                               # the agent types this; no key name in its context
```

The secret name lives only in `manifest.json` and your committed source. Use
`fio-vault exec --only <key> -- <cmd>` only as the ad-hoc escape hatch for genuine
one-offs.

## Cross-Language Usage

The `get` command prints the raw secret to stdout **only at an interactive
terminal or with `--allow-raw`** (see the guard below), making fio-vault usable
as a secret provider from any language or tool. From a script, a pipe, or a
subshell capture, you must opt in with `--allow-raw`.

> Inside an LLM-agent or automation context, prefer `fio-vault exec -- <cmd>`
> (see [Agents & exec](#agents--exec)) so the raw value never passes through the
> caller at all. Use `--allow-raw` only for deliberate human/CI cross-language use.

### Shell

```bash
# Capture into a variable
API_KEY=$(fio-vault get api-key --allow-raw)

# Pipe to another command
fio-vault get ssh-key --allow-raw | ssh-add -

# Use inline
curl -H "Authorization: Bearer $(fio-vault get api-key --allow-raw)" https://api.example.com
```

### Python

```python
import subprocess

def get_secret(key: str) -> str:
    result = subprocess.run(
        ["fio-vault", "get", key, "--allow-raw"],
        capture_output=True, text=True, check=True,
    )
    return result.stdout

api_key = get_secret("api-key")
```

### Go

```go
out, err := exec.Command("fio-vault", "get", "api-key", "--allow-raw").Output()
if err != nil {
    log.Fatal(err)
}
apiKey := string(out)
```

### Ruby

```ruby
api_key = `fio-vault get api-key --allow-raw`.chomp
raise "Secret not found" unless $?.success?
```

The `get` command:
- Is **default-safe**: prints the raw value **only** when stdout is an interactive
  TTY (`process.stdout.isTTY === true`) or `--allow-raw` is passed
- In any other context (pipe, `$(…)`, redirect, agent, CI) it **refuses**: exits
  with code **`3`** (distinct from `1` = not found), prints a hint pointing at
  `exec` and `--allow-raw` to stderr, and writes **nothing** to stdout
- Outputs **only** the raw value to stdout (no labels, no trailing newline)
- Writes errors to stderr; exits with code `1` if the secret is not found
- Supports `--global`, `--cwd`, and `--allow-raw` flags

> **Migration (0.2.0):** `get` no longer prints to a non-TTY by default. Existing
> `$(fio-vault get …)` calls now exit `3` instead of silently leaking the key —
> add `--allow-raw` to keep the old behavior, or move to `fio-vault exec`.

## Environment Variables

| Variable | Purpose |
|---|---|
| `FIO_VAULT_PASSPHRASE` | GPG passphrase for non-interactive decryption. Stripped from the child environment by `fio-vault exec` (least privilege). |
| `PASSWORD_STORE_DIR` | Override pass store directory (default: `<cwd>/vault/`) |

## How it works

Secrets are stored as GPG-encrypted files alongside a `manifest.json` that maps keys to environment variable names:

```
<project>/vault/               Project vault (per-repo)
~/.fio-vault/vault/            Global vault (shared across projects)

vault/
  .gpg-id          GPG key ID (git-ignored)
  manifest.json    { "api-key": "API_KEY", ... } (committed)
  api-key.gpg      Encrypted secret (git-ignored)
  vault.key        Exported private key (git-ignored, for team onboarding)
```

Only `manifest.json` is committed to git. All sensitive files (`.gpg-id`, `*.gpg`, `vault.key`) are excluded via `.gitignore`.

Decryption uses either `pass` (interactive, via gpg-agent) or direct GPG with `FIO_VAULT_PASSPHRASE` (CI/automation).

Key names are validated to prevent path traversal — only `[a-zA-Z0-9._-]` characters are allowed.

## Claude Code Skill

fio-vault includes a Claude Code skill that teaches Claude how to correctly use fio-vault. Install it to get accurate guidance for setup, onboarding, and CI/CD integration:

```bash
bun run install-skill
```

This copies `skill/` to `~/.claude/skills/fio-vault/`. Claude Code will then prefer fio-vault over `.env` files when working in Bun projects.

## Security

- Secrets are encrypted at rest with GPG (RSA 4096-bit)
- Passphrase is passed via stdin to GPG, never visible in process listings
- Key names are validated against path traversal attacks
- `manifest.json` is validated against prototype pollution
- Private keys and encrypted files are excluded from git by default

## Requirements

fio-vault requires three system dependencies. A postinstall check warns you if any are missing.

### Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### GnuPG (`gpg`)

```bash
# macOS
brew install gnupg

# Ubuntu / Debian
sudo apt install gnupg

# Arch
sudo pacman -S gnupg
```

### pass

```bash
# macOS
brew install pass

# Ubuntu / Debian
sudo apt install pass

# Arch
sudo pacman -S pass
```

`pass` is only required for interactive CLI commands (`init`, `set`, `get`, `remove`). The library API can decrypt secrets directly with GPG using `FIO_VAULT_PASSPHRASE`.

### pinentry-mac (macOS only)

```bash
brew install pinentry-mac
```

Required on macOS for GPG passphrase prompts when running outside a terminal (IDEs, GUI apps, spawned processes). Without it, GPG fails with `Inappropriate ioctl for device` because the default `pinentry-curses` requires a TTY.

`fio-vault init` automatically configures `pinentry-mac` in `~/.gnupg/gpg-agent.conf` if it detects the binary. To configure manually:

```bash
echo "pinentry-program $(which pinentry-mac)" >> ~/.gnupg/gpg-agent.conf
gpgconf --kill gpg-agent
```
