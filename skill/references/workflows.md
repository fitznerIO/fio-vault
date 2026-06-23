# FIO Vault Workflows

## Running a secret-bearing command (agents: use this, not `get`)

Run the target command *with* the secret already injected, so the raw key never
returns to the agent. See [agent-safety.md](agent-safety.md) for why.

```bash
# All manifest secrets (project + global fallback) injected into the child:
fio-vault exec -- bun scripts/sync.ts

# Least-privilege: only the named keys:
fio-vault exec --only apify-api-token -- bun scripts/posts-pull-sweep.ts kassel

# Only the global vault:
fio-vault exec --global --only npm-token -- npm publish
```

`exec` inherits stdin, streams the child's stdout/stderr, forwards signals, and
passes the child's exit code through. If the vault is unusable or a secret cannot
be decrypted, it fails loudly and the child never starts (no silent run without
the secret). It strips `FIO_VAULT_PASSPHRASE` from the child's environment.

## New Project Setup

```bash
fio-vault init                          # Creates GPG key, vault/, manifest.json (no-echo passphrase, entered twice)
fio-vault set api-key API_KEY           # Adds secret (no-echo prompt for the value)
fio-vault set db-password               # Auto-generates DB_PASSWORD env var
echo -n "$TOKEN" | fio-vault set api-key --stdin   # History-safe automation (value from stdin)
git add vault/manifest.json
git commit -m "feat: add vault secrets"
```

Never pass a secret value as a CLI argument, and never put a passphrase inline
(`FIO_VAULT_PASSPHRASE=… cmd` leaks via shell history **and** `ps`).

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

### Unattended host (no-passphrase vault)

If the vault was created with `fio-vault init --no-passphrase` (a `%no-protection`
key for a headless single-user VPS — see SKILL.md), onboard with the flag and skip
the `FIO_VAULT_PASSPHRASE` step entirely:

```bash
# vault.key in vault/, then:
fio-vault onboard --no-passphrase    # imports + verifies; no passphrase to set
```

The flag is required — without it, onboard prompts for a passphrase (it never
auto-detects a no-passphrase key, since a decrypt probe would read the gpg-agent
cache and misjudge a protected key while the agent is warm). Filesystem permissions
are the security boundary: `chmod 600 vault/vault.key`, never commit or back it up.

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
