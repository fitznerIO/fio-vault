# PRD 0001 — LLM-sicherer Secret-Zugriff für fio-vault

- **Status:** Draft — durch adversarialen Multi-Agent-Review gehärtet
- **Datum:** 2026-06-22
- **Autor:** Sascha Fitzner (mit Claude Code)
- **Repo:** `fitznerIO/fio-vault`
- **Betrifft Version:** 0.2.0 (enthält eine bewusste Verhaltensänderung an `get`, siehe §4)

---

## 1. Überblick

### Problem

fio-vault wurde geschrieben, damit Secrets sicher verwaltet werden — auch in
einer Welt, in der **LLM-Agenten** (Claude Code u.a.) den Code schreiben und
Befehle ausführen. Genau dieser Zweck wird heute aber **unterlaufen**:

- `fio-vault get <key>` **druckt das Roh-Secret nach stdout**. Führt ein Agent
  das aus, landet der Key in seinem Kontext — und damit potenziell in
  Transkripten, Logs, beim Modell-Anbieter oder in Commits.
- `loadSecrets()` legt Secrets in `process.env` des Prozesses ab, den der Agent
  selbst startet.
- Die mitgelieferte **Claude-Skill** (`skill/SKILL.md`) lehrt das
  `loadSecrets()`/`getSecret()`-Muster (Roh-Rückgabe) **ohne** LLM-Sicherheitshinweis;
  das gefährlichste `$(fio-vault get …)`-Muster bewirbt das **README**.
- Das README bewirbt `get` ausdrücklich als „Cross-Language"-Feature, das den
  Roh-Key nach stdout schreibt.

Real existieren heute zwei widersprüchliche Muster (z.B. im
`lead-harvester-monorepo`: `APIFY_API_TOKEN="$(fio-vault get apify-api-token)"` —
der Token fließt durch den Agenten). Das ist die Wurzel, die dieses PRD behebt.

### Threat-Model (bewusst eng gefasst)

> **Wir verhindern die _versehentliche_ Exposition von Secrets gegenüber dem
> LLM-Agenten.** Claude & Co. _wissen_, dass sie Keys nicht lesen sollen — aber
> in der Praxis passieren Fehler, und ein Key wird ungewollt doch exponiert
> (Subshell-Capture, Debug-Ausgabe, Logzeile, Commit). Diese Unfälle schließen
> wir aus, indem der gesegnete Pfad den Roh-Key technisch gar nicht erst
> herausgibt.

**Nicht im Scope:** Abwehr eines _absichtlich_ bösartigen Agenten. Wer als
gleicher Linux-User läuft und entschlüsseln darf, _kann_ den Key prinzipiell
extrahieren (`/proc/<pid>/environ`, ptrace). Dagegen schützt nur eine
OS-Privileg-Grenze (eigener User) — das wäre für dieses Threat-Model
**überdimensioniert** und ist als Non-Goal dokumentiert (§3, §10).

### Zielgruppe

- **Primär:** LLM-Agenten (Claude Code etc.), die in Bun/TypeScript-Projekten
  secret-pflichtige Befehle ausführen.
- **Sekundär:** Menschen & CI, die fio-vault nutzen (Cross-Language bleibt
  möglich, erfordert künftig eine explizite Freigabe — siehe §4).

### Erfolgskriterien

1. Ein Agent, der der Skill folgt, kann einen secret-pflichtigen Befehl
   ausführen, **ohne dass der Roh-Key je in seinem Kontext/Transkript auftaucht**.
2. `fio-vault get` gibt den Roh-Key **standardmäßig nicht** heraus, wenn die
   Ausgabe nicht an ein TTY geht (typischer Agent-/Skript-Fall); nur mit
   `--allow-raw` (oder am interaktiven Terminal) wird gedruckt.
3. Ein dokumentiertes Secret-Beispiel in Skill/README nutzt `fio-vault exec`
   (in-Repo prüfbar); die reale Harvester-Migration auf `exec` ist als
   **externer Folgeschritt** markiert (F4).
4. Beim **Einlesen** von Secrets/Passphrasen erscheint nichts im Terminal-Echo und
   nichts in der Shell-History; ein `--stdin`-Pfad ermöglicht history-sicheres
   Laden ohne Prompt (ein Wert pro Aufruf).

---

## 2. Leitprinzip

> Der **gesegnete Pfad gibt den Roh-Key nie an den Agenten zurück.** Statt
> „Key holen → selbst verwenden" gilt „Befehl _mit_ Secret ausführen lassen, nur
> Ergebnis zurückbekommen". Damit kann ein Versehen den Key gar nicht erst in den
> Agent-Kontext spülen.

Das ist eine **ergonomische Nicht-Exposition** auf Ebene desselben Users — passend
zum Threat-Model. Eine härtere OS-Grenze bauen wir bewusst nicht (§3).

---

## 3. Architektur — zwei Schichten (+ ein Non-Goal)

### Schicht 0 — Skill-Rewrite (die „Agent-Memory")

Die mitgelieferte Skill **ist** die Anleitung, die jedes LLM liest. Sie wird so
umgeschrieben, dass der sichere Pfad der **Default** ist:

- Agenten: **niemals `fio-vault get`** zur Weiterverarbeitung → immer
  `fio-vault exec`.
- Threat-Model + Begründung dokumentiert.
- `loadSecrets()` bleibt für **App-Startup** (die App lädt ihre eigenen Secrets),
  klar abgegrenzt: nicht der Weg, wie ein Agent ad-hoc an Werte kommt.

### Schicht 1 — `exec` + `get`-Guard (gleicher User, ergonomisch)

**Neuer Befehl `fio-vault exec`:** das sichere Muster *im Tool*.

```bash
fio-vault exec -- lh facebook scrape --page cdustaufenbergnds
fio-vault exec --only apify-api-token -- bun scripts/posts-pull-sweep.ts kassel
```

- Entschlüsselt **intern**, injiziert die Secrets ins **Child-Env**, erbt stdin,
  streamt **nur** stdout/stderr des Childs und reicht dessen Exit-Code durch.
- Der Roh-Key erscheint **nie** auf stdout/stderr des `exec`-Prozesses selbst.
- **Secret-Auswahl:** ohne Flag alle Manifest-Secrets (Projekt + global-Fallback);
  `--only k1,k2` für Least-Privilege.
- **Fail-loud statt still:** ist der Vault nicht nutzbar oder eine erwartete
  Entschlüsselung scheitert (kalter gpg-agent), bricht exec ab (Child startet
  **nicht**) — statt das Child still ohne Secret zu starten. Genaue Spawn-Mechanik
  (Vorab-Gate, Vault-Auflösung, Env/stdin/Signale, Fehlerfälle) in §5 F1.

**`get`-Guard:** default-sicher (TTY-basiert).

- `get` druckt den Roh-Key nur, wenn stdout **ein interaktives TTY** ist
  (Prädikat: `process.stdout.isTTY === true`) — interaktiver Mensch am Terminal.
- Sonst — kein TTY (Subshell-Capture `$(…)`, Pipe, Redirect, Agent, CI; `isTTY`
  ist dann `false`/`undefined`): **Verweigerung**, Exit-Code **`3`** (eigener
  Code, ≠ `1` = „not found"), Hinweis auf `exec` **und** `--allow-raw` auf stderr,
  **kein** Wert auf stdout.
- Override für legitime nicht-interaktive Nutzung (Cross-Language/CI): **`--allow-raw`**.

### Non-Goal — Broker-Daemon / eigener User (bewusst NICHT gebaut)

Ein Broker als separater Linux-User wäre die einzige _harte_ Wand gegen einen
absichtlich bösartigen Agenten. Für unser Threat-Model (versehentliche
Exposition) ist das **überdimensioniert**: mehr Setup (User, systemd, Socket,
Allowlist), mehr laufende Komplexität, ohne den realistischen Fehlerfall besser
abzudecken als Schicht 1. Falls sich das Threat-Model je ändert (z.B. nicht
vertrauenswürdige Agenten), ist dies der dokumentierte Erweiterungspunkt — dann
eigenes PRD.

### Bewusst vermiedene Komplexität

- **Kein** Broker-Daemon / Separate-User-Setup.
- **Kein** Netzwerk-Dienst, keine Sockets, keine Allowlist-Config.
- **Keine** Änderung am Verschlüsselungsschema (weiter GPG/`pass`).
- **Kein** Entfernen von `get` — nur Absichern (mit Override-Pfad).

---

## 4. Entscheidungen mit Begründung

| Entscheidung | Warum |
|---|---|
| `exec` injiziert ins Child-**Env**, nicht nach stdout | Child-Env wird nicht in den Agent-Kontext echot; der Agent sieht die normale Programmausgabe (Restvektor `env`/`printenv`: §10). `FIO_VAULT_PASSPHRASE` wird aus dem Child-Env entfernt. |
| `get`-Guard **default-sicher** (kein TTY → blockt), Override `--allow-raw` | Schützt auch dann, wenn die Agent-Umgebung _nicht_ explizit markiert ist (vergessene Konfig ist selbst ein typischer Unfall). Bewusste Reibung für nicht-interaktive Nutzung ist der Preis. |
| Block-Exit-Code **`3`** (≠ `1`) | Bestehende Cross-Language-Aufrufe behandeln jeden Non-Zero als Fehler (README Python `check=True`, Ruby `$?.success?`); ein eigener Code ≠ `1` hält „geblockt" von „nicht gefunden" für jeden unterscheidbar, der doch gezielt auf `1` prüft. |
| `exec`-Default = alle Secrets, `--only` opt-in | Rückwärtskompatibel & bequem (wie `loadSecrets`), Least-Privilege bei Bedarf. |
| `get` guarden statt entfernen | Cross-Language/CI bleibt via `--allow-raw` möglich; kein Funktionsverlust, nur eine bewusste Freigabe-Geste. |
| Secret-Eingabe: No-Echo + `--stdin`, Wert nie als Argument | Shell-History ist schon sicher (Wert ist kein CLI-Argument); die Lücken sind das Klartext-**Echo** der Prompts und ein fehlender history-sicherer Automatisierungs-Pfad. No-Echo schließt Scrollback/Screen-Share; `--stdin` verhindert unsichere Workarounds (heredoc/inline). |
| **Verhaltensänderung** statt stiller Kompatibilität | Bestehende `$(fio-vault get …)`-Aufrufe in Skripten brechen ab sofort sichtbar (Exit ≠ 0 mit Hinweis) statt still einen Key zu leaken. Dokumentiert in CHANGELOG + README-Migration. Version 0.2.0 (0.x erlaubt Breaking in Minor). |

---

## 5. Features (priorisiert)

### Must-have — Phase 1 (Schicht 0 + 1)

**F1 — `fio-vault exec` (Komplexität: M) — präzise Spawn-Spezifikation**
- `fio-vault exec [--only k1,k2] [--global] [--cwd p] -- <cmd...>`
- **Argument-Trennung:** mit `util.parseArgs({ strict:true, allowPositionals:true })`
  parsen. `parseArgs` behandelt `--` als Options-Terminator und legt alles danach
  **verbatim** in `positionals` (auch bekannte Flags) — der `strict`-Throw trifft
  nur unbekannte Flags **vor** dem ersten `--`. Also: exec-Flags vor `--`,
  Child-argv = positionals; kein separater String-Split nötig. Fehlt `--` bzw. ist
  die Child-argv leer → Fehler, Exit ≠ 0.
- **Vorab-Gate:** zuerst `isConfigured()` prüfen (analog `get`/`status`,
  cli.ts:289/359). Vault nicht nutzbar → Fehler + Exit ≠ 0, Child startet **nicht**.
- **Vault-Auflösung:** ohne Flag Projekt-first + global-Fallback. `--global` =
  **nur global** — im Bestand gibt es kein natives „nur global"; via
  `cwd = getGlobalVaultDir()` **und** `global:false` auflösen (analog cli.ts:295/364).
  `loadSecrets({global:true})` lädt fälschlich beide — nicht verwenden; exec baut
  Auflösung/Injektion selbst (`getSecret({global})` liefert keine key→envVar-Map).
- **`--only`:** filtert auf Manifest-**Keys** (nicht envVar); pro Key projekt-first
  Mapping+Wert; Key nur global → global; kollidierende envVars → zuerst aufgelöste
  Quelle gewinnt (no-overwrite wie `loadSecrets`). Key in **keinem** Manifest →
  Fehler, Exit ≠ 0.
- **Entschlüsselungs-Fälle trennen:**
  - `.gpg` fehlt zu Manifest-Eintrag → Warnung auf **stderr**, Var nicht setzen,
    fortfahren (Skip-Semantik wie `loadSecrets` — das selbst aber **nicht** warnt;
    die Warnung ist neu für exec).
  - `.gpg` da, interne Entschlüsselung scheitert (kalter gpg-agent, kein
    `FIO_VAULT_PASSPHRASE`, kein TTY) → **klarer Fehler** (Key-Name, nie Wert;
    Hinweis `FIO_VAULT_PASSPHRASE` / gpg-agent vorwärmen), gpg-eigenes stderr
    verwerfen (analog `decrypt()`, gpg.ts:72-79), Exit ≠ 0 — **nicht** still
    fortfahren oder hängen.
- **Child-Env:** `{ ...process.env, ...secrets }`, aber **`FIO_VAULT_PASSPHRASE`
  entfernen** (Least-Privilege — die Master-Passphrase entsperrt den ganzen Vault
  und gehört nicht ins aufgerufene Kommando).
- **stdin:** Child erbt stdin (`stdin: "inherit"`), damit interaktive bzw.
  stdin-konsumierende Kommandos (Prompts, REPLs, `ssh-add -`, Pipes) funktionieren.
- **Working Directory:** `--cwd` bestimmt **nur** die Vault-/Manifest-Auflösung;
  das Child läuft im aktuellen Arbeitsverzeichnis des Aufrufers (kein cwd-Override).
- **Signale:** explizite Handler für SIGINT/SIGTERM → `proc.kill(sig)` weiterleiten
  (Bun forwardet **nicht** automatisch); **nicht** selbst `process.exit` rufen,
  sondern immer `await proc.exited` abwarten und dessen Code durchreichen (liefert
  bei Signal bereits `128+signum` — keine manuelle Rechnung, `proc.signalCode` ist
  ein String).
- **Akzeptanz (binär prüfbar):** Roh-Key nie in der exec-Eigenausgabe; Exit-Code
  durchgereicht; gpg-agent-Modus funktioniert **nur** bei gecachter Passphrase /
  headless-fähigem pinentry (sonst klarer Fehler statt stillem Child, s.o.).

**F2 — `get`-Guard (Komplexität: S)**
- Prädikat: `process.stdout.isTTY === true` = interaktiv; alles andere
  (`false`/`undefined`) = nicht-interaktiv.
- Akzeptanzkriterien:
  - Nicht-interaktiv (kein TTY) **und** kein `--allow-raw` → Exit-Code **`3`**,
    Hinweis (auf `exec` und `--allow-raw`) auf stderr, **kein** Wert auf stdout.
  - Block-Exit (`3`) ist verschieden vom „not found"-Exit (`1`).
  - `--allow-raw` → druckt den Wert (jeder Kontext).
  - Interaktives TTY (ohne `--allow-raw`) → Bestandsverhalten (druckt).

**F3 — Skill- & Doku-Rewrite (Komplexität: M)**
- `skill/SKILL.md` + neue `skill/references/agent-safety.md`.
- Akzeptanzkriterien:
  - `exec` ist der dokumentierte Default für Agenten.
  - Threat-Model (versehentliche Exposition) erklärt.
  - `get` nur für interaktive Menschen / Cross-Language mit `--allow-raw` ausgewiesen.
  - **Alle** widersprechenden README-Stellen aktualisiert: Quick-Start
    (`get`-Beispiel), CLI-Tabelle, der **Cross-Language-Einleitungssatz**
    (README:104 „prints the raw secret to stdout …" → „… mit `--allow-raw` bzw. am
    interaktiven Terminal"), die Code-Beispiele (Python/Ruby/Go/Shell mit
    `--allow-raw`) und die „The `get` command:"-Garantieliste (TTY-Guard + Exit `3`).
  - Quellen-Hinweis: Das `$(fio-vault get …)`-Muster steht im **README**; die
    SKILL.md lehrt heute `loadSecrets()`/`getSecret()` (nicht das CLI-`get`).
    F3 adressiert **beide** Quellen.
  - **Library `getSecret()`** im SKILL als app-/menschenseitig eingeordnet:
    Agenten sollen ihn nicht zur Roh-Ausgabe nutzen. Er gibt wie CLI-`get` den
    Roh-Wert zurück, ist aber **nicht** guard-fähig (Library-Aufruf, kein
    Prozessrand) — bewusst so; Hinweis in `agent-safety.md`.

**F4 — Harvester-Migration (extern/nachgelagert, Komplexität: S)**
- Konkrete Migrationsziele im `lead-harvester-monorepo`:
  `scripts/poc/booking-poc.ts` (`getApifyToken()`, spawnSync `fio-vault get` →
  bricht nach F2 in non-TTY mit Exit `3`) und die Agent-Memory `CLAUDE.md`
  (lehrt weiter `APIFY_API_TOKEN="$(fio-vault get …)"`).
- Bevorzugter Pfad: `fio-vault exec --only apify-api-token -- <cmd>`.
- **Umsetzung liegt im externen Harvester-Repo** (kein Teil des mergbaren
  fio-vault-Phase-1-Codes) — hier nur als Referenz/Folgeschritt.

**F5 — History-/echo-sichere Secret-Eingabe (Komplexität: S–M)**
Ergänzt den **Eingabe-/Write-Pfad** (menschlich), komplementär zum LLM-Read-Pfad.
- Ausgangslage: Werte sind schon **kein** CLI-Argument (interaktiver Prompt → nicht
  in der Shell-History; cli.ts `cmdSet` fragt den Wert per `prompt()` ab, `passInsert`
  reicht ihn via stdin an `pass`). **Lücken:** die Prompts echoen Klartext
  (`set`-Wert, `init`/`onboard`-Passphrase) und es fehlt ein nicht-interaktiver,
  history-sicherer Lade-Pfad.
- **No-Echo — Mechanik:** das bestehende Shared-Readline (`getReadline`) per
  **Output-Muting** verdeckt einlesen (`rl._writeToOutput`-Override während der
  Secret-Eingabe: Prompt-Text sichtbar, Zeichen-Echo unterdrückt). Bevorzugt
  gegenüber `setRawMode`/Char-für-Char, weil es mit `getReadline`/`closePrompt`
  komponiert und kein eigenes Ctrl-C-/Backspace-Handling braucht. **TTY-gebunden:**
  ohne interaktives TTY gibt es kein Echo zu unterdrücken (no-op).
- Gilt für `set`-Wert und alle Passphrase-Prompts. `init`-Passphrase mit
  **Doppeleingabe** (Tippfehler = unwiederbringlich); Vergleich auf **sanitisierten**
  Werten (`sanitizeGpgInput`, cli.ts:128 — der sanitisierte Wert wird die echte
  GPG-Passphrase), Mismatch → Abbruch ohne Key-Generierung.
- **`fio-vault set <key> [ENV_VAR] --stdin`:** liest den Wert **ausschließlich** aus
  stdin (`await Bun.stdin.text()`); **kein** `prompt()`/`getReadline()` (sonst
  EOF-Hang am selben stdin) — `cmdSet` verzweigt **vor** dem prompt-Aufruf.
  History-sicher pipebar: `pass show x | fio-vault set k --stdin`,
  `fio-vault set k --stdin < datei` (Datei `chmod 600`).
- Akzeptanzkriterien:
  - `set`-Wert / Passphrasen erscheinen **nicht** im Terminal-Echo (TTY-Fall).
  - Wert nie als CLI-Argument (Bestand beibehalten).
  - `--stdin`: Wert aus stdin, kein Prompt, kein Echo; genau **ein** abschließendes
    `\n` getrimmt (Rest roh). **Round-Trip-Hinweis:** der Lese-Pfad (`decrypt()`,
    gpg.ts:76) trimmt ohnehin beidseitig → Rand-Whitespace-Treue ist **kein** Ziel;
    nur **innere** Zeilenumbrüche überleben. Der No-Echo-Prompt behält das
    bestehende `.trim()` (cli.ts:29).
  - `--stdin` mit **leerer** stdin (z.B. `pass show <nonexistent> | …`) → **Fehler,
    Exit ≠ 0**, **kein** Manifest-Write (Manifest erst **nach** erfolgreichem
    `passInsert` schreiben — kein verwaister Eintrag). Im Gegensatz zum interaktiven
    Prompt, wo leere Eingabe = „nur Manifest" zulässig bleibt.
  - `--stdin` an einem **interaktiven** TTY (`process.stdin.isTTY === true`, keine
    Pipe) → klarer Fehler + Exit ≠ 0 („--stdin erwartet gepipte/umgeleitete
    Eingabe"), statt blockierend zu warten.
  - Doku-Regel: Werte nie als Argument, **Passphrase nie inline**
    (`FIO_VAULT_PASSPHRASE=… cmd` → History **und** `ps`); stattdessen Prompt
    (No-Echo) oder `--stdin`.

### Could-have — Phase 2

- `FIO_VAULT_AGENT`-Signal als **additive** Extra-Leitplanke (blockt `get` auch im
  Pseudo-TTY). Bewusst **nicht** Phase 1: der TTY-Guard trägt das Threat-Model
  allein, und ein erst zu setzendes Signal schützt im Versehensfall nicht
  zuverlässig (vergessene Konfig = selbst der Unfall).
- Library-Ergonomie: `withSecrets(keys, fn)` / programmierbares `exec` aus TS.
- Sekundenscharfes Ausblenden bekannter Secret-Werte aus Child-Ausgabe (optional;
  primär bleibt es Verantwortung des aufgerufenen Programms).

---

## 6. Datenmodell

**Keine Änderung am Vault-Format** (`manifest.json` + `*.gpg` + `.gpg-id` +
`vault.key`). Es kommen keine neuen persistenten Strukturen hinzu.

---

## 7. API / Schnittstellen

### CLI

```
fio-vault exec [--only <k1,k2>] [--global] [--cwd <p>] -- <cmd> [args...]   # NEU
fio-vault get <key> [--allow-raw] [--global] [--cwd <p>]                     # geändert: Guard
fio-vault set <key> [ENV_VAR] [--stdin] [--global] [--cwd <p>]              # geändert: --stdin + No-Echo (F5)
```

`init`/`onboard` erhalten No-Echo-Eingabe (F5); `remove`/`status` unverändert.
Die neuen Flags (`--only`, `--allow-raw`, `--stdin`) müssen in der
`parseArgs`-Optionsliste registriert werden (sonst wirft `strict:true`). Für `exec`
gilt zusätzlich die `--`-Trennung aus §5 F1.

### Env-Variablen

| Variable | Zweck |
|---|---|
| `FIO_VAULT_PASSPHRASE` | unverändert: nicht-interaktive Entschlüsselung. **Wird von `exec` aus dem Child-Env entfernt** (Least-Privilege). |
| `PASSWORD_STORE_DIR` | unverändert. |

(`FIO_VAULT_AGENT` ist bewusst **nicht** Teil von Phase 1 → Phase 2 / Could-have, §5.)

---

## 8. Test-Strategie (TDD)

Bestehendes Muster fortführen: `bun:test`, `spyOn` auf `gpg`-Modul, Temp-Dirs,
`global: false` zur Isolation. TTY-Zustand via Mock von `process.stdout.isTTY`.

**Kritischer Assert (`exec`):** Der Secret-Wert taucht **nicht** in der vom
`exec`-Prozess **selbst** erzeugten Ausgabe auf. Mechanik-Hinweis: Dieser Assert
braucht das **echte Capturen** der exec-Eigen-stdout/stderr (realer Prozess-/
Spawn-Rand); das in-process `spyOn`-Muster erreicht ihn nicht. Child-Ausgabe
getrennt prüfen (`expect(execOwnOutput).not.toContain(SECRET)`).

- **`exec`:** Child erhält Env-Var; exec-Eigenausgabe enthält den Wert nicht;
  Exit-Code-Durchreichung (inkl. Signal); Vorab-Gate (Vault nicht nutzbar →
  Exit ≠ 0, kein Child); `.gpg` fehlt → Warnung/Skip vs. Decrypt-Fehler → Exit ≠ 0;
  `--only`-Filter (Key-basiert) + global-Fallback; `--global` = nur global;
  `FIO_VAULT_PASSPHRASE` **nicht** im Child-Env; Fehler bei fehlendem `--`. Der
  Modus-Unterschied (Passphrase vs. gpg-agent) wird auf `decrypt`-Ebene
  (`gpg.test.ts`) abgedeckt; für `exec` genügt der Assert, dass die An-/Abwesenheit
  von `FIO_VAULT_PASSPHRASE` korrekt an `decrypt` durchgereicht wird (Assert auf
  decrypt-opts), da `spyOn(gpg)` beide Modi auf denselben Mock zieht.
- **`get`-Guard:** kein TTY (`isTTY` false/undefined) → Exit `3`, kein Wert auf
  stdout; `--allow-raw` → druckt; interaktives TTY → druckt. Block-Exit (`3`) ≠
  not-found-Exit (`1`).
- **Eingabe (F5):** `--stdin` liest den Wert aus stdin (kein Prompt), trimmt genau
  ein abschließendes `\n`; **leere stdin → Exit ≠ 0 + kein Manifest-Write**;
  `--stdin` an interaktivem TTY → Exit ≠ 0; Wert ist kein CLI-Argument. No-Echo per
  **optionalem PTY-/Integrationstest** prüfen (Eingabe über Pseudo-Terminal,
  asserten dass die erfasste Terminal-Ausgabe den Wert **nicht** enthält — analog
  zum exec-Prozessrand-Assert); mindestens als „empfohlen" markiert.

---

## 9. Projektstruktur

```
src/
  exec.ts            # NEU: Vorab-Gate, Secret-Injektion (Env minus Passphrase), Child-Spawn (stdin inherit, Signal-Forwarding)
  cli.ts             # erweitert: exec-Subcommand; Guard in cmdGet (--allow-raw, TTY-Check); No-Echo (rl._writeToOutput) + set --stdin (Bun.stdin, vor prompt verzweigen) (F5)
  (vault.ts, gpg.ts, manifest.ts, utils.ts, types.ts unverändert)
skill/
  SKILL.md           # umgeschrieben (Schicht 0)
  references/
    agent-safety.md  # NEU: Threat-Model + sichere Muster
    workflows.md     # ergänzt
docs/
  prd/0001-llm-safe-secret-access.md   # dieses Dokument
README.md            # Quick-Start, CLI-Tabelle, Cross-Language + Garantieliste ergänzt
CHANGELOG.md         # Breaking-/Behavior-Change dokumentiert
package.json         # version 0.1.0 → 0.2.0
```

**Konventionen (Bestand):** alle Shell-Calls via `Bun.spawn`; Key-Namen gegen
Path-Traversal validiert; Manifest gegen Prototype-Pollution; Passphrase nur via
stdin an gpg.

---

## 10. Nicht-funktionale Anforderungen

- **Sicherheit (Scope = Versehen):** Roh-Key nie auf stdout des Tool-Prozesses;
  Secrets nur im Child-Env (ohne `FIO_VAULT_PASSPHRASE`); default-sicheres `get`.
  **Restvektor (ehrlich):** exec gibt den Key nicht selbst aus, kann aber nicht
  verhindern, dass das vom Agenten gewählte Child seine Env ausgibt
  (`env`/`printenv`/Debug-Logger) oder dass `getSecret()`/`loadSecrets()` in einem
  Ad-hoc-Script geloggt werden — beides am Guard vorbei. Adressiert durch die
  **Skill-Regel** (Agenten nutzen nur `exec` mit dem Zielbefehl), nicht technisch
  erzwungen. **Nicht** abgedeckt: absichtliche Extraktion durch einen
  gleichberechtigten User/Agenten (Non-Goal).
- **Kompatibilität:** `exec` ist additiv. `get` ändert sein Verhalten bei
  fehlendem TTY (Breaking für `$(fio-vault get …)`-Skripte) → bewusst, sichtbar,
  mit `--allow-raw` migrierbar. **Deliverable:** `package.json` von 0.1.0 auf
  0.2.0 bumpen + CHANGELOG-Eintrag (0.x erlaubt Breaking in Minor).
- **Performance:** `exec` = die ohnehin nötige Entschlüsselung + ein Spawn —
  vernachlässigbar.
- **Portabilität:** läuft überall, wo fio-vault heute läuft (kein systemd/Socket
  nötig).

---

## 11. Offene Punkte & Default-Entscheidungen

| Punkt | Vorgeschlagener Default | Begründung |
|---|---|---|
| `exec` bei fehlendem/unentschlüsselbarem Secret | Zwei Fälle (in §5 F1 entschieden): `.gpg` fehlt → Warnung+fortfahren; `.gpg` da, Decrypt scheitert → Fehler+Exit ≠ 0, **kein** stilles Child. | „Fail loud" im primären exec-Kontext (non-TTY, gpg-agent). |
| Soll `exec` Child-Ausgabe nach Secret-Werten filtern? | Nein (Phase 1) | Primär Verantwortung des aufgerufenen Programms; Filter wäre fehleranfällig. Als Could-have notiert. |
| Migrationshinweis bei geblocktem `get` | Fehlertext nennt `exec` **und** `--allow-raw` | Nutzer landet sofort beim richtigen Pfad. |
| `set --stdin`: Trailing-Newline & Trim | Genau **ein** abschließendes `\n` trimmen, Rest roh. Aber: Lese-Pfad (`decrypt`, gpg.ts:76) trimmt ohnehin beidseitig → Rand-Whitespace-Round-Trip ist kein Ziel, nur innere Zeilen überleben. No-Echo-Prompt behält `.trim()` (cli.ts:29). | Pipe-Konvention + ehrlich gegenüber Bestand-Read-Trim. |
| `set --stdin`: leere/abgebrochene stdin | **Fehler, Exit ≠ 0, kein Manifest-Write** (Manifest erst nach erfolgreichem `passInsert`) | Verhindert stillen Datenverlust im beworbenen Pipe-Use-Case. |
| Passphrase-Doppeleingabe (No-Echo) | `init`: ja, Vergleich auf sanitisierten Werten (`sanitizeGpgInput`), Mismatch → Abbruch; `set`-Wert/`onboard`: nein | Balance Sicherheit/Ergonomie. |

---

## Anhang — Phasen-Roadmap

1. **Phase 1 (Must):** Skill-Rewrite + `exec` + `get`-Guard + history-/echo-sichere
   Secret-Eingabe (F5). Behebt das Threat-Model vollständig. SemVer 0.2.0.
2. **Phase 2 (Could):** `FIO_VAULT_AGENT`-Signal, Library-Ergonomie
   (`withSecrets`), optionales Output-Masking.

**Bewusst nicht auf der Roadmap:** Broker-Daemon / eigener User (siehe §3 Non-Goal).
</content>
