# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

fio-vault is a GPG-based secret management library and CLI for Bun projects. It encrypts secrets using GPG/pass and loads them into `process.env` at runtime. Requires Bun, GnuPG (`gpg`), and `pass`.

## Commands

- `bun test` — run all tests
- `bun test src/__tests__/vault.test.ts` — run a single test file
- `bunx tsc --noEmit` — typecheck

## Architecture

The codebase is a single-layer library + CLI with no external runtime dependencies:

- **`src/index.ts`** — public API re-exports (`loadSecrets`, `listKeys`, `getSecret`, `isConfigured`, etc.)
- **`src/vault.ts`** — core logic: loads manifest, decrypts secrets, populates `process.env` (no-overwrite semantics)
- **`src/gpg.ts`** — GPG operations: decryption via `pass show` (interactive) or direct `gpg --decrypt` with passphrase via stdin (CI/automation)
- **`src/manifest.ts`** — reads/writes `vault/manifest.json` which maps secret keys to env var names
- **`src/utils.ts`** — pure helpers: path resolution (`getVaultDir`, `getManifestPath`, `getGpgFilePath`), key-to-env-var conversion
- **`src/types.ts`** — shared interfaces (`VaultOptions`, `KeyStatus`)
- **`src/cli.ts`** — CLI entry point using `util.parseArgs`, commands: `init`, `set`, `remove`, `status`, `onboard`

## Key Patterns

- All shell commands use `Bun.spawn` (not `child_process`)
- Decryption has two paths: passphrase-based (direct GPG, for CI) vs agent-based (`pass show`, interactive)
- The vault directory defaults to `<cwd>/vault/` and is overridable via `PASSWORD_STORE_DIR`
- Tests use `bun:test` with `spyOn` to mock `gpg` module functions; each test creates a temp directory with a manifest
