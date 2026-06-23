# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (0.x: breaking changes may land in a
minor release).

## [0.3.0] — 2026-06-23

Unattended VPS support. Adds an opt-in passphrase-free key mode so decryption works
headless (no TTY, no `pinentry`, no `FIO_VAULT_PASSPHRASE`) on a single-user box,
where an at-rest passphrase is friction without security. Additive and opt-in — the
default `init`/`onboard` behavior is unchanged.

### Added

- **`fio-vault init --no-passphrase`** — generate a `%no-protection` GPG key (private
  key unencrypted at rest, guarded only by filesystem permissions). Skips all
  interactive prompts so it runs headless, prints a loud at-rest warning, and exports
  `vault.key` without the loopback/passphrase plumbing. The default `init` still
  requires a passphrase (double-entry, aborts on mismatch).
- **`fio-vault onboard --no-passphrase`** — import a passphrase-free key without
  dead-ending at the passphrase prompt, verify decryption with `FIO_VAULT_PASSPHRASE`
  unset, and skip the "export the passphrase" instructions. The flag is required (no
  auto-detection: any decrypt probe reads the gpg-agent cache and would misclassify a
  passphrase-protected key while the agent is warm).

### Notes

- No change to `decrypt()`/`src/gpg.ts`: a `%no-protection` key decrypts through the
  existing `pass show` path on a cold agent with nothing in the environment. Verified
  by `src/__tests__/cli-init.test.ts`.
- `--no-passphrase` makes filesystem permissions the security boundary. Keep
  `vault.key` out of git and backups; use only on a trusted single-user host. For a
  multi-user host, use a separate OS user instead.

## [0.2.0] — 2026-06-22

LLM-safe secret access. Makes the blessed path never hand a raw key back, so an
accidental exposure can't spill a secret into an agent's context, a transcript,
a log, or a commit.

### Added

- **`fio-vault exec [--only k1,k2] [--global] [--cwd p] -- <cmd...>`** — run a
  command with the vault's secrets injected into its environment. Decrypts
  internally, inherits stdin, streams only the child's stdout/stderr, forwards
  signals, and passes the child's exit code through. The raw key never appears on
  `exec`'s own output. Strips `FIO_VAULT_PASSPHRASE` from the child environment
  (least privilege). Fails loudly if the vault is unusable or a secret cannot be
  decrypted — the child never starts silently without its secret.
- **`fio-vault set <key> [ENV_VAR] --stdin`** — read the value from stdin
  (history-safe, no prompt; e.g. `pass show x | fio-vault set k --stdin`). Empty
  or interactive-TTY stdin is a hard error, and the manifest entry is written only
  after a successful store (no orphaned entries).
- **No-echo secret entry** — the interactive `set` value prompt and all passphrase
  prompts (`init`, `onboard`) no longer echo typed characters. `init` now asks for
  the passphrase twice and aborts before generating a key on mismatch.

### Changed

- **(Breaking) `fio-vault get` is now default-safe.** It prints the raw secret only
  when stdout is an interactive TTY or `--allow-raw` is passed. In any
  non-interactive context (pipe, `$(…)`, redirect, agent, CI) it refuses with exit
  code **`3`** (distinct from `1` = not found), prints a hint pointing at `exec`
  and `--allow-raw` to stderr, and writes nothing to stdout.

  **Migration:** existing `$(fio-vault get …)` calls in scripts now exit `3`
  instead of silently leaking the key. Add `--allow-raw` to keep the old behavior,
  or move to `fio-vault exec -- <cmd>` so the raw value never passes through the
  caller.
- Invalid arguments (unknown/ambiguous flags, malformed keys) now fail with a
  clean one-line message and exit `1` instead of a raw stack trace.

[0.2.0]: https://github.com/fitznerIO/fio-vault/releases/tag/v0.2.0
