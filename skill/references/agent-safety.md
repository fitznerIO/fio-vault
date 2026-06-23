# Agent Safety — secrets and LLM agents

fio-vault exists so that secrets stay safe **even when an LLM agent (Claude Code
and others) writes the code and runs the commands**. This page is the rule set
for agents.

## Threat model (deliberately narrow)

> We prevent the **accidental** exposure of a secret to the LLM agent.

Agents *know* they should not read raw keys — but in practice mistakes happen and
a key gets exposed anyway: a subshell capture, a debug print, a stray log line, a
commit. We close those accidents off by making the blessed path **never hand the
raw key back** in the first place.

**Not in scope:** defending against a *deliberately* malicious agent. Anyone
running as the same Linux user who is allowed to decrypt *can* extract a key
(`/proc/<pid>/environ`, ptrace). Guarding against that needs an OS privilege
boundary (a separate user) and is an explicit non-goal here.

## The rule for agents

**Never run `fio-vault get` to obtain a value and then use it.** Instead, run the
target command *with* the secret already in its environment:

```bash
# ✅ Do this — the key is injected into the child, never returned to you
fio-vault exec --only apify-api-token -- bun scripts/posts-pull-sweep.ts kassel

# ❌ Never this — the raw token flows through your context / transcript / logs
APIFY_API_TOKEN="$(fio-vault get apify-api-token)" bun scripts/posts-pull-sweep.ts kassel
```

`fio-vault exec` decrypts internally, injects the secrets into the child process's
environment, inherits stdin, streams only the child's stdout/stderr, and passes
the child's exit code through. The raw key never appears on `exec`'s own output.

## Why `get` will fight you (and that's intended)

`fio-vault get` is **default-safe**. It prints the raw secret **only** when stdout
is an interactive TTY (a human at a terminal) or you pass `--allow-raw`. In any
non-interactive context — subshell capture `$(…)`, a pipe, a redirect, an agent,
CI — it refuses:

- exits with code **`3`** (a dedicated code, distinct from `1` = "not found"),
- prints a hint (pointing at `exec` and `--allow-raw`) to **stderr**,
- writes **nothing** to stdout.

So `$(fio-vault get …)` from an agent or a script blocks loudly instead of
silently leaking. `--allow-raw` is the explicit opt-out for legitimate
cross-language / CI use by a human.

## `loadSecrets()` vs `getSecret()` (library API)

- **`loadSecrets()` is for app startup and committed wrapper scripts.** The boundary
  is *who authored the call*, not the function itself:
  - An agent that **authors an ad-hoc inline call** to `loadSecrets()`/`getSecret()`
    and could then log the value = **bad** (no process boundary, nothing guards it).
  - An agent that merely **invokes a committed, reviewed script** which calls
    `loadSecrets()` internally = **the best pattern** — the agent runs `bun run sync`,
    never names a key, and the value never crosses a boundary it observes. Prefer this
    over `exec` for any recurring task; the secret name stays in `manifest.json` +
    source, out of the agent's transcript.
  - Use `exec` as the ad-hoc escape hatch when no committed script exists yet.
- **`getSecret()` returns the raw value** to the caller, exactly like CLI `get`.
  But it is a library call with **no process boundary**, so it **cannot** be
  guarded the way CLI `get` is. Treat it as app-/human-side only; an agent must
  not author a call that prints or captures a key. Use a wrapper script or `exec`.

## Honest residual vector

`exec` does not print the key itself, but it cannot stop a child *you chose* from
printing its own environment (`env`, `printenv`, a debug logger), nor stop
`getSecret()`/`loadSecrets()` from being logged in an ad-hoc script — both bypass
the `get` guard. This is addressed by the rule above (agents run `exec` with the
**target command**, not an env-dumping one), not by a technical guarantee.

## Entering secret values safely (humans)

- A secret value is **never** a CLI argument (it would land in shell history and
  `ps`). The interactive `set`/`init`/`onboard` prompts read it with **no echo**.
- For automation, pipe it in history-safely: `fio-vault set <key> --stdin`
  (reads the value from stdin; one value per call).
  Examples: `pass show x | fio-vault set k --stdin`,
  `fio-vault set k --stdin < secret.txt` (with `chmod 600` on the file).
- **Never put a passphrase inline** like `FIO_VAULT_PASSPHRASE=… cmd` — that
  leaks via shell history **and** `ps`. Use the no-echo prompt, or set it once in
  your shell config / a CI secret.
