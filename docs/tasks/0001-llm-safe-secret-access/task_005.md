# Task 005: Release-Prep — Version 0.2.0 + CHANGELOG

## Dependencies
- Requires: Task 001, 002, 003, 004

## Description
(PRD §4 „Verhaltensänderung", §9 Projektstruktur, §10 Kompatibilität)

Phase 1 enthält eine bewusste **Verhaltensänderung** an `get` (bricht in non-TTY mit
Exit `3` ab, statt still zu drucken). Sichtbar dokumentieren, nicht still.

- `package.json` von **`0.1.0` auf `0.2.0`** bumpen (0.x erlaubt Breaking in Minor).
- `CHANGELOG.md`-Eintrag:
  - **Added:** `fio-vault exec`; `set --stdin` + No-Echo-Eingabe.
  - **Changed (Breaking):** `get` blockt in non-TTY (Exit `3`); Migration via
    `--allow-raw`.
- README-Migrationshinweis (sofern nicht bereits in Task 004 abgedeckt).

## Expected Outcome
- `package.json` Version = `0.2.0`.
- `CHANGELOG.md` dokumentiert `exec`, den `get`-Guard (Breaking + Migration via
  `--allow-raw`) sowie `set --stdin`/No-Echo.

## Agent Context
Abschluss-Task nach allen Code- (001–003) und Doku-Änderungen (004). Klein; nur
`package.json` + `CHANGELOG.md` (+ ggf. README-Migrationsnotiz).
</content>
