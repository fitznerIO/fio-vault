# Task 001: `get`-Guard — default-sicher (TTY-basiert)

## Dependencies
- Requires: None

## Description
(PRD §3 „Schicht 1 / get-Guard", §5 F2, §4)

`fio-vault get` darf den Roh-Key nicht mehr bedingungslos drucken. Neuer Guard in
`cmdGet` (`src/cli.ts`; einzige Druckstelle: `process.stdout.write(value)`):

- `get` druckt den Roh-Key **nur**, wenn stdout ein interaktives TTY ist —
  Prädikat: `process.stdout.isTTY === true`.
- Sonst — kein TTY (Subshell-Capture `$(…)`, Pipe, Redirect, Agent, CI; `isTTY` ist
  dann `false`/`undefined`): **Verweigerung**, Exit-Code **`3`** (eigener Code,
  ≠ `1` = „not found"), Hinweis auf `exec` **und** `--allow-raw` auf **stderr**,
  **kein** Wert auf stdout.
- Override für legitime nicht-interaktive Nutzung (Cross-Language/CI): **`--allow-raw`**.
  Flag in der `parseArgs`-Optionsliste registrieren (`strict:true`).

Begründung Exit `3` (≠ `1`): bestehende Cross-Language-Aufrufe behandeln jeden
Non-Zero als Fehler (README Python `check=True`, Ruby `$?.success?`); ein eigener
Code hält „geblockt" von „nicht gefunden" für jeden unterscheidbar, der gezielt
auf `1` prüft.

## Expected Outcome
- Nicht-interaktiv (kein TTY) **und** kein `--allow-raw` → Exit-Code `3`, Hinweis
  (auf `exec` und `--allow-raw`) auf stderr, **kein** Wert auf stdout.
- Block-Exit (`3`) verschieden vom „not found"-Exit (`1`).
- `--allow-raw` → druckt den Wert (jeder Kontext).
- Interaktives TTY (ohne `--allow-raw`) → Bestandsverhalten (druckt).
- Tests (`bun:test`): TTY-Zustand via Mock von `process.stdout.isTTY`
  (`=== true` vs. `false`/`undefined`); alle vier Fälle abgedeckt; Block-Exit `3` ≠
  not-found-Exit `1`.

## Agent Context
Erster Task; baut direkt auf dem bestehenden `cmdGet`/`parseArgs` in `src/cli.ts`
auf. Etabliert die Konventionen (Exit-Code-Schema, TTY-Prädikat, Flag-Registrierung
in der strikten `parseArgs`-Optionsliste), auf denen 002/003 aufbauen.
</content>
