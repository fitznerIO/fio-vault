# FIO Vault Workflows

## New Project Setup

```bash
fio-vault init                          # Creates GPG key, vault/, manifest.json
fio-vault set api-key API_KEY           # Adds secret (prompts for value)
fio-vault set db-password               # Auto-generates DB_PASSWORD env var
git add vault/manifest.json
git commit -m "feat: add vault secrets"
```

Application code:

```typescript
import { loadSecrets } from "fio-vault";

await loadSecrets();
console.log(process.env.API_KEY);       // Decrypted value
```

## Team Member Onboarding

New members need `vault.key` (shared via password manager, NEVER git):

```bash
# 1. Get vault.key from team, place in vault/ directory
# 2. Run onboarding:
fio-vault onboard
# Imports GPG key, verifies decryption, instructs to set FIO_VAULT_PASSPHRASE
```

After onboarding, add to shell config (`~/.zshrc` or `~/.bashrc`):
```bash
export FIO_VAULT_PASSPHRASE="<passphrase-from-password-manager>"
```

Verify: `fio-vault status` — all secrets should show `+`.

## CI/CD Integration (GitHub Actions)

Set two GitHub Secrets:
- `GPG_PRIVATE_KEY`: base64-encoded `vault/vault.key` (`base64 -i vault/vault.key`)
- `FIO_VAULT_PASSPHRASE`: the GPG passphrase

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install

      - name: Import GPG key
        run: echo "${{ secrets.GPG_PRIVATE_KEY }}" | base64 -d | gpg --batch --import

      - name: Run
        env:
          FIO_VAULT_PASSPHRASE: ${{ secrets.FIO_VAULT_PASSPHRASE }}
        run: bun run start
```

No `pass` binary needed in CI — `loadSecrets()` auto-detects `FIO_VAULT_PASSPHRASE` and decrypts directly with GPG.

## Global Secrets

For secrets shared across all projects (NPM tokens, shared API keys):

```bash
fio-vault init --global
fio-vault set --global npm-token NPM_TOKEN
```

Automatically available via `loadSecrets()` as fallback. Disable: `{ global: false }`.
