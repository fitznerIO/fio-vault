# Task 003: History-/echo-sichere Secret-Eingabe (No-Echo + `set --stdin`)

## Dependencies
- Requires: Task 002 (gleiche `cli.ts`; nach `exec`)

## Description
(PRD §5 F5)

Ergänzt den Eingabe-/Write-Pfad (menschlich), komplementär zum LLM-Read-Pfad.
Ausgangslage: Werte sind schon **kein** CLI-Argument (`cmdSet` fragt den Wert per
`prompt()` ab, `passInsert` reicht ihn via stdin an `pass`). **Lücken:** die Prompts
echoen Klartext (`set`-Wert, `init`/`onboard`-Passphrase) und es fehlt ein
nicht-interaktiver, history-sicherer Lade-Pfad.

- **No-Echo — Mechanik:** das bestehende Shared-Readline (`getReadline`) per
  **Output-Muting** verdeckt einlesen (`rl._writeToOutput`-Override während der
  Secret-Eingabe: Prompt-Text sichtbar, Zeichen-Echo unterdrückt). Bevorzugt
  gegenüber `setRawMode`/Char-für-Char, weil es mit `getReadline`/`closePrompt`
  komponiert und kein eigenes Ctrl-C-/Backspace-Handling braucht. **TTY-gebunden:**
  ohne interaktives TTY no-op.
- Gilt für `set`-Wert und alle Passphrase-Prompts. `init`-Passphrase mit
  **Doppeleingabe**; Vergleich auf **sanitisierten** Werten (`sanitizeGpgInput` —
  der sanitisierte Wert wird die echte GPG-Passphrase), Mismatch → Abbruch ohne
  Key-Generierung.
- **`fio-vault set <key> [ENV_VAR] --stdin`:** liest den Wert **ausschließlich** aus
  stdin (`await Bun.stdin.text()`); **kein** `prompt()`/`getReadline()` (sonst
  EOF-Hang am selben stdin) — `cmdSet` verzweigt **vor** dem prompt-Aufruf.
  `--stdin` in der `parseArgs`-Optionsliste registrieren.

## Expected Outcome
- `set`-Wert / Passphrasen erscheinen **nicht** im Terminal-Echo (TTY-Fall).
- Wert nie als CLI-Argument (beibehalten).
- `--stdin`: Wert aus stdin, kein Prompt/Echo; genau **ein** abschließendes `\n`
  getrimmt (Rest roh). **Round-Trip-Hinweis:** der Lese-Pfad (`decrypt()`, gpg.ts)
  trimmt ohnehin beidseitig → Rand-Whitespace-Treue ist **kein** Ziel; nur innere
  Zeilenumbrüche überleben. Der No-Echo-Prompt behält das bestehende `.trim()`.
- `--stdin` mit **leerer** stdin (z.B. `pass show <nonexistent> | …`) → **Fehler,
  Exit ≠ 0**, **kein** Manifest-Write (Manifest erst **nach** erfolgreichem
  `passInsert` schreiben — kein verwaister Eintrag). Im Gegensatz zum interaktiven
  Prompt, wo leere Eingabe = „nur Manifest" zulässig bleibt.
- `--stdin` an einem **interaktiven** TTY (`process.stdin.isTTY === true`, keine
  Pipe) → klarer Fehler + Exit ≠ 0 („--stdin erwartet gepipte/umgeleitete Eingabe").
- Tests: `--stdin`-Pfad; Newline-Trim; **leere stdin → Exit ≠ 0 + kein
  Manifest-Write**; `--stdin` an interaktivem TTY → Exit ≠ 0; „Wert nicht als
  Argument". No-Echo per **optionalem PTY-/Integrationstest** (erfasste
  Terminal-Ausgabe enthält den Wert **nicht**), mindestens als „empfohlen".

## Agent Context
Ändert `cmdSet`/`cmdInit`/`cmdOnboard` + das `prompt()`-Umfeld in `src/cli.ts` (nach
Task 002). **Wichtig:** `cmdSet` schreibt heute das Manifest **vor** dem Wertlesen und
no-oppt bei leerem Wert mit Exit 0 — für `--stdin` muss diese Reihenfolge/Logik
angepasst werden (Manifest erst **nach** erfolgreichem `passInsert`; leere stdin =
Fehler), sonst entsteht ein verwaister Manifest-Eintrag (stiller Datenverlust).
</content>
