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

# Retrieve a single secret (prints to stdout)
fio-vault get api-key

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
fio-vault set <key> [ENV_VAR]  Add/update a secret
fio-vault get <key>            Print a decrypted secret to stdout
fio-vault remove <key>         Remove a secret
fio-vault status               Show vault status
fio-vault onboard              Setup on a new machine (import GPG key)

Options:
  --global             Use global vault (~/.fio-vault/) instead of project vault
  --cwd <path>         Project root directory (default: cwd)
  --help               Show this help
```

## Cross-Language Usage

The `get` command prints the raw secret to stdout, making fio-vault usable as a secret provider from any language or tool.

### Shell

```bash
# Capture into a variable
API_KEY=$(fio-vault get api-key)

# Pipe to another command
fio-vault get ssh-key | ssh-add -

# Use inline
curl -H "Authorization: Bearer $(fio-vault get api-key)" https://api.example.com
```

### Python

```python
import subprocess

def get_secret(key: str) -> str:
    result = subprocess.run(
        ["fio-vault", "get", key],
        capture_output=True, text=True, check=True,
    )
    return result.stdout

api_key = get_secret("api-key")
```

### Go

```go
out, err := exec.Command("fio-vault", "get", "api-key").Output()
if err != nil {
    log.Fatal(err)
}
apiKey := string(out)
```

### Ruby

```ruby
api_key = `fio-vault get api-key`.chomp
raise "Secret not found" unless $?.success?
```

The `get` command:
- Outputs **only** the raw value to stdout (no labels, no trailing newline)
- Writes errors to stderr
- Exits with code `1` if the secret is not found
- Supports `--global` and `--cwd` flags like all other commands

## Environment Variables

| Variable | Purpose |
|---|---|
| `FIO_VAULT_PASSPHRASE` | GPG passphrase for non-interactive decryption |
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
