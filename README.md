# fio-vault

GPG-based secret management for Bun projects. Encrypt secrets in your repo with GPG/pass, load them into `process.env` at runtime.

## Install

```bash
bun add github:fitznerIO/fio-vault
```

## Quick Start

```bash
# Initialize vault (one-time)
bunx fio-vault init

# Add a secret
bunx fio-vault set api-key API_KEY

# Check status
bunx fio-vault status

# New machine setup
bunx fio-vault onboard
```

## Library API

```typescript
import { loadSecrets, listKeys, getSecret, isConfigured } from "fio-vault";

// Load all secrets into process.env (no-overwrite)
await loadSecrets();

// With options
await loadSecrets({ cwd: "/path/to/project", passphrase: "override" });

// List secrets with status
const keys = await listKeys();
// [{ key: "api-key", envVar: "API_KEY", exists: true }, ...]

// Get single secret
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
fio-vault onboard              Setup on new machine
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `FIO_VAULT_PASSPHRASE` | GPG passphrase for non-interactive decryption |
| `PASSWORD_STORE_DIR` | Override pass store directory (default: `<cwd>/vault/`) |

## How it works

Secrets are stored as GPG-encrypted files in `vault/` alongside a `manifest.json` that maps keys to environment variable names:

```
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
