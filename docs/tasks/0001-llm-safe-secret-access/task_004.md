# Task 004: Skill- & Doku-Rewrite

## Dependencies
- Requires: Task 001, 002, 003

## Description
(PRD §3 „Schicht 0", §5 F3)

Die mitgelieferte Skill **ist** die „Agent-Memory", die jedes LLM liest. So
umschreiben, dass der sichere Pfad der **Default** ist.

- `skill/SKILL.md` umschreiben + neue `skill/references/agent-safety.md`.
- `exec` ist der dokumentierte Default für Agenten; Threat-Model (versehentliche
  Exposition) erklärt; `loadSecrets()` als **App-Startup** abgegrenzt (nicht der Weg,
  wie ein Agent ad-hoc an Werte kommt).
- `get` nur für interaktive Menschen / Cross-Language mit `--allow-raw` ausgewiesen.
- **Alle** widersprechenden README-Stellen aktualisieren: Quick-Start
  (`get`-Beispiel), CLI-Tabelle, **Cross-Language-Einleitungssatz** (README:104
  „prints the raw secret to stdout …" → „… mit `--allow-raw` bzw. am interaktiven
  Terminal"), Code-Beispiele (Python/Ruby/Go/Shell mit `--allow-raw`) und die
  „The `get` command:"-Garantieliste (TTY-Guard + Exit `3`).
- Quellen-Hinweis: Das `$(fio-vault get …)`-Muster steht im **README**; die SKILL.md
  lehrt heute `loadSecrets()`/`getSecret()` (nicht das CLI-`get`). F3 adressiert
  **beide** Quellen.
- **Library `getSecret()`** im SKILL als app-/menschenseitig einordnen: Agenten
  sollen ihn nicht zur Roh-Ausgabe nutzen; gibt wie CLI-`get` den Roh-Wert zurück,
  ist aber **nicht** guard-fähig (Library-Aufruf, kein Prozessrand). Hinweis in
  `agent-safety.md`.
- `exec` dokumentieren inkl. eines Apify-Beispiels
  `fio-vault exec --only apify-api-token -- <cmd>` (deckt Erfolgskriterium 3 in-Repo).
- Restvektor ehrlich benennen (PRD §10): `exec` verhindert nicht, dass ein gewähltes
  Child seine Env ausgibt (`env`/`printenv`) oder dass `getSecret()`/`loadSecrets()`
  in einem Ad-hoc-Script geloggt werden → Skill-Regel: Agenten nutzen nur `exec` mit
  dem Zielbefehl.

## Expected Outcome
- `skill/SKILL.md` + `skill/references/agent-safety.md` beschreiben das sichere
  Muster (`exec`) als Default, das Threat-Model und `get` nur mit `--allow-raw`.
- README an allen genannten Stellen konsistent mit dem **realen** Verhalten aus
  Task 001–003.
- **Doku-Regel verankert** (PRD §5 F5): Werte nie als CLI-Argument, **Passphrase nie
  inline** (`FIO_VAULT_PASSPHRASE=… cmd` landet in Shell-History **und** `ps`);
  stattdessen No-Echo-Prompt oder `--stdin`.

## Agent Context
Reine Doku/Skill-Arbeit; muss das in Task 001–003 implementierte Verhalten exakt
spiegeln (Exit-Codes, TTY-Guard, `exec`-Semantik, `--stdin`/No-Echo). Keine
Code-Änderung an `src/`.
</content>
