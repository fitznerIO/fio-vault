# Phase 1 — LLM-sicherer Secret-Zugriff für fio-vault

Umsetzung von **PRD 0001** (`docs/prd/0001-llm-safe-secret-access.md`), **Phase 1
(Schicht 0 + 1)**. Das PRD wurde durch zwei adversariale Multi-Agent-Reviews
gehärtet; die Akzeptanzkriterien je Feature stehen dort präzise. Diese Tasks
dekomponieren **ausschließlich Phase 1**.

- Repo: `fitznerIO/fio-vault` (`~/workspace/fio-vault`)
- Ziel-Release: **0.2.0** (enthält eine bewusste Verhaltensänderung an `get`)

## Tasks

| # | Task | Depends on | Status |
|---|---|---|---|
| 001 | F2 — `get`-Guard (default-sicher, TTY, Exit 3, `--allow-raw`) | — | TODO |
| 002 | F1 — `fio-vault exec` (`exec.ts` + Subcommand, Spawn-Spec) | 001 | TODO |
| 003 | F5 — History-/echo-sichere Secret-Eingabe (No-Echo + `set --stdin`) | 002 | TODO |
| 004 | F3 — Skill- & Doku-Rewrite (SKILL.md, agent-safety.md, README) | 001, 002, 003 | TODO |
| 005 | Release-Prep — Version 0.2.0 + CHANGELOG (Breaking Change) | 001, 002, 003, 004 | TODO |
| 006 | F4 — Harvester-Migration (extern, anderes Repo, Referenz) | 002 | TODO |

## Abhängigkeiten / Reihenfolge

Linear **001 → 002 → 003 → 004 → 005**. Grund: 001/002/003 ändern alle `src/cli.ts`
(u.a. die `parseArgs`-Optionsliste) — sequentiell ausführen vermeidet Konflikte und
etabliert Konventionen (Exit-Code-Schema, TTY-Prädikat, Flag-Registrierung) früh.
004 (Doku) muss das **reale** Verhalten von 001–003 spiegeln. 005 (Release) ganz
zuletzt. **006** hängt nur an 002 (`exec`), liegt aber in einem **anderen Repo**
(`lead-harvester-monorepo`) und ist **kein** Teil des mergebaren fio-vault-Codes —
separat/nachgelagert.

**Art der Abhängigkeit:** Die „Depends on" sind **Reihenfolge-Kopplungen**
(serielle Editierung derselben `src/cli.ts`/`parseArgs`-Optionsliste, `strict:true`
→ keine Merge-Konflikte), **keine** funktionalen Verhaltens-Voraussetzungen:
002/003 brauchen kein Artefakt aus 001/002, sondern nur konfliktfreie sequentielle
Edits. `exec` (002) ruft eigenständig `isConfigured`/`getGlobalVaultDir`/`decrypt`.

**Erfolgskriterien-Mapping (PRD §1):** Kriterium 1 (kein Roh-Key im
Agent-Kontext/Transkript) wird **integrativ** erfüllt — durch **Task 002**
(exec-Nichtexposition, Prozessrand-Assert) **plus Task 004** (Skill-Regel „Agenten
nutzen nur `exec`"). Kriterium 2 → Task 001, Kriterium 3 → Task 004 (exec-Beispiel),
Kriterium 4 → Task 003.

## Konventionen (PRD §9) — für jeden Task gültig

- Alle Shell-Calls via `Bun.spawn`. Tests mit `bun:test` (`spyOn` auf das
  `gpg`-Modul, Temp-Dirs, `global:false` zur Isolation; TTY via Mock von
  `process.stdout.isTTY`).
- Neue Flags (`--allow-raw`, `--only`, `--stdin`) **in der `parseArgs`-Optionsliste
  registrieren** (sonst wirft `strict:true`). Inkrementell — jeder Task nur sein Flag.
- Key-Namen gegen Path-Traversal validiert; Manifest gegen Prototype-Pollution;
  Passphrase nur via stdin an gpg.
- Exit-Code-Schema: `1` = not found / generischer Fehler, `3` = `get`-Guard-Block,
  `128 + signum` = signalbeendetes exec-Child.

## Threat-Model & Non-Goals (NICHT bauen)

Threat-Model: ausschließlich **versehentliche** Exposition gegenüber dem LLM.
Bewusste Non-Goals: Broker-Daemon / eigener User, LLM-Approval-Check,
`FIO_VAULT_AGENT`, `withSecrets`-Library-Ergonomie, Output-Masking. (Alle Phase 2
oder dauerhaft out of scope — siehe PRD §3 Non-Goal, §5 Could-have, §10.)
</content>
