# Task 002: `fio-vault exec` — Secret-Injektion + Child-Spawn

## Dependencies
- Requires: Task 001 (gemeinsame `cli.ts`/`parseArgs`-Basis; Exit-Code-/Flag-Konventionen)

## Description
(PRD §3 „Schicht 1", §5 F1 — präzise Spawn-Spezifikation)

Neuer Befehl `fio-vault exec` — das sichere Muster im Tool: entschlüsselt
**intern**, injiziert Secrets ins **Child-Env**, erbt stdin, streamt **nur**
stdout/stderr des Childs und reicht dessen Exit-Code durch. Der Roh-Key erscheint
**nie** auf stdout/stderr des `exec`-Prozesses selbst. Neue Datei `src/exec.ts` +
`exec`-Subcommand in `src/cli.ts`.

Signatur: `fio-vault exec [--only k1,k2] [--global] [--cwd p] -- <cmd...>`

**Spawn-Spezifikation:**
- **Argument-Trennung:** mit `util.parseArgs({ strict:true, allowPositionals:true })`
  parsen. `parseArgs` behandelt `--` als Options-Terminator und legt alles danach
  **verbatim** in `positionals` (auch bekannte Flags); der `strict`-Throw trifft nur
  unbekannte Flags **vor** dem ersten `--`. Also: exec-Flags vor `--`, Child-argv =
  positionals; **kein** separater String-Split. Fehlt `--` bzw. ist die Child-argv
  leer → Fehler, Exit ≠ 0.
- **Vorab-Gate:** zuerst `isConfigured()` prüfen (analog `get`/`status`). Vault nicht
  nutzbar → Fehler + Exit ≠ 0, Child startet **nicht**.
- **Vault-Auflösung:** ohne Flag Projekt-first + global-Fallback. `--global` =
  **nur global** — via `cwd = getGlobalVaultDir()` **und** `global:false` auflösen.
  `loadSecrets({global:true})` lädt fälschlich beide — **nicht** verwenden; exec baut
  Auflösung/Injektion selbst (`getSecret({global})` liefert keine key→envVar-Map).
- **`--only`:** filtert auf Manifest-**Keys** (nicht envVar); pro Key projekt-first
  Mapping+Wert; Key nur global → global; kollidierende envVars → zuerst aufgelöste
  Quelle gewinnt (no-overwrite). Key in **keinem** Manifest → Fehler, Exit ≠ 0.
- **Entschlüsselungs-Fälle trennen:**
  - `.gpg` fehlt zu Manifest-Eintrag → Warnung auf **stderr**, Var nicht setzen,
    fortfahren (Skip-Semantik wie `loadSecrets`; die Warnung ist neu für exec).
  - `.gpg` da, interne Entschlüsselung scheitert (kalter gpg-agent, kein
    `FIO_VAULT_PASSPHRASE`, kein TTY) → **klarer Fehler** (Key-Name, nie Wert;
    Hinweis `FIO_VAULT_PASSPHRASE`/gpg-agent vorwärmen), gpg-eigenes stderr verwerfen
    (analog `decrypt()`, gpg.ts:72-79), Exit ≠ 0 — **nicht** still fortfahren oder hängen.
- **Child-Env:** `{ ...process.env, ...secrets }`, aber **`FIO_VAULT_PASSPHRASE`
  entfernen** (Least-Privilege).
- **stdin:** Child erbt stdin (`stdin: "inherit"`).
- **Working Directory:** `--cwd` bestimmt **nur** die Vault-/Manifest-Auflösung; das
  Child läuft im aktuellen Arbeitsverzeichnis des Aufrufers (kein cwd-Override).
- **Signale:** explizite Handler für SIGINT/SIGTERM → `proc.kill(sig)` (Bun forwardet
  **nicht** automatisch); **nicht** selbst `process.exit`, sondern `await proc.exited`
  abwarten und dessen Code durchreichen (liefert bei Signal bereits `128+signum`;
  keine manuelle Rechnung, `proc.signalCode` ist ein String).
- `--only` in der `parseArgs`-Optionsliste registrieren.

## Expected Outcome
- Child sieht die Secrets als Env-Var (Manifest-Mapping); exec-Eigenausgabe enthält
  den Wert **nicht**; Exit-Code durchgereicht (inkl. Signal).
- Vorab-Gate, `--only`/`--global`-Semantik, beide Entschlüsselungs-Fälle,
  Passphrase-Strip, `stdin: "inherit"`, Signal-Forwarding wie spezifiziert.
- gpg-agent-Modus funktioniert **nur** bei gecachter Passphrase/headless-fähigem
  pinentry (sonst klarer Fehler statt stillem Child).
- Tests: **kritischer Assert via echtem Spawn-Rand** (exec-Eigenausgabe enthält den
  SECRET nicht); Exit-Durchreichung; Vorab-Gate (Vault nicht nutzbar → Exit ≠ 0,
  kein Child); `.gpg` fehlt (Warnung/Skip) vs. Decrypt-Fehler (Exit ≠ 0);
  `--only` (Key-basiert) + global-Fallback; `--global` = nur global; fehlendes `--`;
  `FIO_VAULT_PASSPHRASE` **nicht** im Child-Env. Modus-Unterschied (Passphrase vs.
  gpg-agent) auf `decrypt`-Ebene (`gpg.test.ts`); für exec genügt der Assert, dass
  An-/Abwesenheit von `FIO_VAULT_PASSPHRASE` korrekt an `decrypt` durchgereicht wird.

## Agent Context
Baut auf der in Task 001 erweiterten `cli.ts`/`parseArgs` auf. `src/exec.ts` ist neu
und nutzt bestehende Bausteine aus `vault.ts`/`gpg.ts`/`utils.ts` (`decrypt`,
`getGlobalVaultDir`, `isConfigured`, Manifest-Helper). Headline-Feature von Phase 1.
</content>
