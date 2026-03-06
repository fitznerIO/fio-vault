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
fio-vault remove <key>         Remove a secret
fio-vault status               Show vault status
fio-vault onboard              Setup on a new machine (import GPG key)

Options:
  --global             Use global vault (~/.fio-vault/) instead of project vault
  --cwd <path>         Project root directory (default: cwd)
  --help               Show this help
```

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

## Security

- Secrets are encrypted at rest with GPG (RSA 4096-bit)
- Passphrase is passed via stdin to GPG, never visible in process listings
- Key names are validated against path traversal attacks
- `manifest.json` is validated against prototype pollution
- Private keys and encrypted files are excluded from git by default

## Requirements

- [Bun](https://bun.sh)
- [GnuPG](https://gnupg.org/) (`gpg`)
- [pass](https://www.passwordstore.org/) (for `init`/`set`/`remove`)
