# PRD 0002 — Unbeaufsichtigter VPS-Betrieb: passphrasenloser Vault + skriptseitiger Secret-Trigger

- **Status:** ✅ Implementiert in 0.3.0 (Commit auf `feat/unattended-no-passphrase`). Durch adversariale Multi-Agent-Konvergenz gehärtet; das GPG-Verhalten ist jetzt als Repo-Test in [`src/__tests__/cli-init.test.ts`](../../src/__tests__/cli-init.test.ts) verankert (F3). **Hinweis:** Eine bewusste Abweichung vom ursprünglichen Plan — die in F2/§10 erwogene `onboard`-Auto-Erkennung wurde **verworfen** (Decrypt-Probe liest den gpg-agent-Cache → False-Positive bei warmem Agent); das `--no-passphrase`-Flag ist der einzige Trigger. `cli.ts`-Zeilenreferenzen unten geben den Stand bei Erstellung des PRD wieder und können durch spätere Edits driften — maßgeblich ist der Code.
- **Datum:** 2026-06-23
- **Autor:** Sascha Fitzner (mit Claude Code)
- **Repo:** `fitznerIO/fio-vault`
- **Betrifft Version:** 0.3.0 (additiv, opt-in — kein Breaking Change für bestehende Vaults)
- **Baut auf:** [PRD 0001 — LLM-sicherer Secret-Zugriff](0001-llm-safe-secret-access.md) (liefert `exec` + `get`-Guard, hier vorausgesetzt)

---

## 1. Überblick

### Problem

fio-vault läuft heute auch auf einem **headless VPS**. Dort ist der passphrasen­geschützte
GPG-Schlüssel **Friktion ohne Sicherheitsgewinn**:

- Jede Entschlüsselung braucht entweder einen **warmen gpg-agent** (interaktives
  `pinentry`, das auf einem headless-System ohne TTY **hängt/scheitert**) oder
  `FIO_VAULT_PASSPHRASE` **irgendwo im Environment** — was selbst ein leakbares
  Artefakt ist, das ein LLM-Agent per `env`/`echo`/Crash-Dump finden kann.
- `fio-vault init` erzwingt heute hart eine Passphrase ([cli.ts:164-167](../../src/cli.ts#L164-L167)):
  ein leerer Wert → `process.exit(1)`. Ein passphrasenloser Schlüssel ist nur per
  manuellem Workaround außerhalb von fio-vault erreichbar.

Die in einer früheren Session geäußerte These — *„eine At-Rest-Passphrase bringt auf
diesem System keine zusätzliche Sicherheit“* — ist **wahr, eng gefasst** (siehe §2).
Der saubere Fix ist **nicht** ein leerer Passphrase-String (`FIO_VAULT_PASSPHRASE=""`
ist ein stiller Footgun, §4), sondern ein **GPG-Schlüssel ohne Passphrase**
(`%no-protection`) als **opt-in** Modus, abgesichert allein durch Dateirechte.

Parallel dazu adressiert dieses PRD die **ursprüngliche Design-Absicht**: Die KI soll
Secret-Abrufe **nicht aktiv triggern**; das Holen von Tokens gehört in **Skripte**, die
die KI nur noch **aufruft**. `exec` (PRD 0001) löst die *Wert*-Exposition, lässt aber die
*Namens*-Exposition offen (§3). Dieses PRD macht das **skriptseitige Wrapper-Muster**
zum dokumentierten Default.

### Threat-Model (unverändert zu PRD 0001, hier präzisiert für den VPS)

> **Wir verhindern die _versehentliche_ Exposition von Secrets gegenüber dem
> LLM-Agenten** — derselbe Linux-User, dieselbe Maschine.

**Nicht im Scope** (explizit, unverändert):
- Ein **absichtlich bösartiger** Same-User-Agent. Wer als gleicher User entschlüsseln
  darf, kann den Schlüssel extrahieren (`/proc/<pid>/environ`, ptrace, Datei lesen).
  Dagegen hilft nur eine **OS-Privileg-Grenze** (eigener User) — Non-Goal.
- **Multi-User-/Multi-Tenant-VPS, shared NFS-Home, Compliance-Isolation.** Dort ist
  der echte Fix ein **separater OS-User**, nicht eine Passphrase. Wenn sich das
  Threat-Model dorthin verschiebt, ist das der Trigger für ein eigenes PRD — nicht jetzt.

### Erfolgskriterien

1. `fio-vault init --no-passphrase` erzeugt einen `%no-protection`-Schlüssel; eine
   anschließende Entschlüsselung (`loadSecrets` / `exec` / `status`) gelingt auf einem
   **headless VPS ohne TTY, ohne `FIO_VAULT_PASSPHRASE`, mit kaltem gpg-agent** — ohne
   `pinentry`-Prompt, ohne Hang, Exit 0.
2. Der **Default** von `init`/`onboard` bleibt **unverändert** (Passphrase erforderlich).
   Der passphrasenlose Modus ist ausschließlich opt-in und bei Erzeugung **laut markiert**.
3. Ein dokumentiertes, wiederverwendbares **Wrapper-Muster** (Skript ruft
   `loadSecrets()` intern; die KI ruft nur den Task-Namen) steht in Skill + README; die
   KI nennt im Steady-State weder Secret-**Wert** noch Secret-**Name**.
4. **Keine Änderung an `decrypt()` / `src/gpg.ts`** (siehe §3, empirisch verifiziert) —
   die kleinstmögliche korrekte Änderung.

---

## 2. Die Passphrase-Frage — ehrlich entschieden

Auf einem **Single-User-VPS** liegen der `*.gpg`-Ciphertext, der private Schlüssel
(`vault.key` / `~/.gnupg`) **und** jede Passphrase-Quelle (env-Var, `~/.zshrc`,
gpg-agent-Cache, eine 0600-Datei) **unter derselben UID**. Die At-Rest-Passphrase hat
dann genau **einen** echten Job: eine **Off-Box-Kopie** des Schlüssels zu schützen
(gestohlenes Backup/Snapshot, geleaktes Disk-Image, versehentlicher `git push` von
`vault.key`).

| Angreifer / Szenario | Passphrase hilft? | Warum |
|---|---|---|
| KI als gleicher User (versehentlich) | **✗ Theater** | KI läuft als Vault-User → liest Schlüssel **und** Passphrase ohnehin. Genau der In-Scope-Fall. |
| Bösartiger gleicher User | **— außer Scope** | Braucht OS-Grenze (eigener User). Passphrase ändert nichts. PRD-Non-Goal. |
| Gestohlenes Backup / Disk-Image | **✓ Echt** | Off-Box-Kopie ist mit Passphrase wertlos, ohne sofort nutzbar. **Der einzige echte Verlust** — operativ mitigiert (§7 Backup-Hygiene). |
| Versehentlicher `git push` von `vault.key` | **✓ Echt** | Gleiche Logik. Deshalb opt-in + lauter Warnhinweis + `.gitignore`. |

**Fazit:** Eine Passphrase wird erst dann echt, wenn ein **Mensch sie interaktiv tippt**,
damit ein unbeaufsichtigter Prozess den Schlüssel **nicht** nutzen kann. Auf einem
unbeaufsichtigten VPS willst du das **Gegenteil** — der Prozess *soll* ihn nutzen. Dort
ist die Passphrase reine Friktion. `%no-protection` ist der ehrliche Weg; die
Dateirechte werden **explizit zur Sicherheitsgrenze** (statt einer Passphrase, die hier
falsche Sicherheit suggeriert).

**Verworfene Alternativen** (vom adversarialen Review bestätigt — jeweils null
Same-User-Gewinn bei mehr beweglichen Teilen):
- `FIO_VAULT_PASSPHRASE`-in-env: gleiche Sicherheit, aber leakbares Master-Artefakt im
  Eltern-Env der KI (`exec` strippt es nur aus dem **Child**).
- Passphrase in 0600-Datei: gleicher Same-User-Lesbarkeitsgrad wie der Schlüssel, plus
  Boot-Lade-Schritt.
- `gpg-preset-passphrase` bei Boot: keygrip-Management + systemd-Hook + Re-Prompt bei
  Reboot. Lohnt nur **mit** separatem OS-User.
- `age`/`sops`: GPG→age-Rewrite, Verlust von `pass`/`pinentry`-Interop, teure Rotation —
  auf Same-User-Box kein Gewinn. Nur mit Separate-User-Isolation sinnvoll.
- Broker-Daemon: gibt der KI nach dem Entschlüsseln weiterhin Klartext → adressiert
  versehentliche Exposition **gar nicht**. PRD-0001-Non-Goal.

---

## 3. `%no-protection` vs. „leere Passphrase“ — und warum `decrypt()` unangetastet bleibt

### Die technische Klärung

- **`%no-protection`** ist eine GPG-Batch-Direktive bei der **Schlüsselerzeugung**: der
  private Schlüssel wird **unverschlüsselt** auf der Platte abgelegt. Es gibt nichts zu
  entsperren → kein `pinentry`, kein TTY, keine env-Var nötig.
- Eine **„leere Passphrase“** ist nicht zuverlässig dasselbe: im **Batch-Modus** (genau
  was fio-vault via `--batch --gen-key` nutzt, [cli.ts:175-184](../../src/cli.ts#L175-L184))
  ist das Weglassen der `Passphrase:`-Zeile kein verlässliches Signal — man **muss**
  `%no-protection` explizit schreiben. (Interaktiv erkennt modernes GnuPG „leer“ und legt
  den Schlüssel ebenfalls als `%no-protection` ab — aber bestätigungspflichtig; im Batch
  zählt nur die explizite Direktive.)
- **`FIO_VAULT_PASSPHRASE=""`** (leerer String) ist ein **stiller Footgun**: in
  [gpg.ts:48-52](../../src/gpg.ts#L48-L52) ist `if (passphrase)` falsy für den leeren
  String → es wird **still** der `pass show`-Pfad genommen, nicht der Loopback-Pfad. Wir
  verwenden den leeren String **nirgends** als Trigger.

### Verifizierte, load-bearing Tatsache (kein Decrypt-Code-Change nötig)

Im vorausgehenden Analyse-Workflow **manuell verifiziert** (GnuPG 2.5.x, ad-hoc
generierter `%no-protection`-Testschlüssel — **noch nicht** als Repo-Test verankert; das
holt F3 nach): Ein `%no-protection`-Schlüssel entschlüsselt über fio-vaults
**bestehenden** Fallback-Zweig ([gpg.ts:62-69](../../src/gpg.ts#L62-L69), `pass show`) bei
**kaltem gpg-agent, ohne TTY, ohne `FIO_VAULT_PASSPHRASE`, stdin von `/dev/null` →
Exit 0**. gpg-agent startet automatisch, findet nichts zu entsperren und ruft **nie**
`pinentry`. Das dokumentierte „pass-show hängt headless“ ist ausschließlich ein
**Passphrase-Schlüssel-Symptom** (pinentry ohne TTY) — entferne die Passphrase, und es
verschwindet. **F3 verankert diesen Beleg als automatisierten Test**, damit die Annahme
nicht stillschweigend brechen kann.

> **Konsequenz:** `decrypt()` / `src/gpg.ts` bleibt **unverändert**. Insbesondere **kein**
> Loopback-mit-leerer-Passphrase-Zweig und **kein** Marker-File/Env-Flag-Trigger im
> Decrypt-Pfad. Das wäre eine Verteidigung für eine Konfiguration, die fio-vault gar nicht
> unterstützt (`init` bricht ohne `pass` ab, [cli.ts:138-141](../../src/cli.ts#L138-L141)),
> und ist für jeden initialisierten Vault unnötig.

---

## 4. Der skriptseitige Secret-Trigger (die ursprüngliche Absicht)

`exec` (PRD 0001) schließt die **Wert**-Lücke (Roh-Token kommt nie zur KI zurück),
lässt aber die **Namens**-Lücke offen: die KI muss `--only apify-token` tippen, der
**Identifier** landet im Transcript. Das skriptseitige Wrapper-Muster schließt sie.

### Zwei-Tier-Vertrag für Agenten

**Tier 1 — Default (für alles, was öfter als einmal läuft): committed Wrapper-Skript.**
Der Secret-**Name** lebt nur in committed Source + `vault/manifest.json` — nie im Befehl,
Reasoning oder Transcript der KI.

```ts
// scripts/sync.ts  — committed, von dir geschrieben
import { loadSecrets } from "fio-vault";
await loadSecrets();                       // entschlüsselt Manifest-Secrets in process.env
// ... process.env.APIFY_API_TOKEN nutzen — die KI hat den Namen nie getippt
```

```jsonc
// package.json
{ "scripts": { "sync": "bun scripts/sync.ts" } }
```

Die KI ruft nur `bun run sync`. Mit dem `%no-protection`-Schlüssel braucht
`loadSecrets()` **kein** `FIO_VAULT_PASSPHRASE` — es funktioniert headless.

**Wichtige Klarstellung** (korrigiert das aktuelle `agent-safety.md`-Framing):
`loadSecrets()` ist **schlecht**, wenn die KI einen **ad-hoc Inline-Aufruf selbst
schreibt** (und den Wert loggen könnte); es ist das **beste** Muster, wenn die KI nur ein
**committed, reviewtes Skript aufruft**. Gleiche Funktion — die Grenze ist, *wer den
Aufruf geschrieben hat*.

**Tier 2 — Notausgang (echte Einmal-Fälle): `fio-vault exec`.**
```bash
fio-vault exec --only apify-token -- bun scripts/sync.ts
```
Starke Wert-Isolation; der Namens-Identifier im Transcript ist der bewusst akzeptierte
Restvektor — nur für ad-hoc, nicht als Default.

**Verbannt für die KI:** `fio-vault get`-Capture `$(…)` (bereits per non-TTY-Exit-`3`
geguardet, PRD 0001) und env-dumpende Childs unter `exec` (`exec -- env`/`printenv`).

---

## 5. Features (priorisiert)

### Must-have — Phase 1

**F1 — `fio-vault init --no-passphrase` (Komplexität: M)**
- Neues Flag, registriert in der `parseArgs`-Optionsliste
  ([cli.ts:493-500](../../src/cli.ts#L493-L500)) als
  `"no-passphrase": { type: "boolean", default: false }`; an `cmdInit` durchreichen.
- Bei gesetztem Flag in `cmdInit` ([cli.ts:137-258](../../src/cli.ts#L137-L258)):
  - Den Passphrase-Prompt + die Doppeleingabe + den **„Passphrase is required“-Guard**
    ([cli.ts:162-173](../../src/cli.ts#L162-L173)) überspringen.
  - Das `--gen-key`-Batch-Input ([cli.ts:178-180](../../src/cli.ts#L178-L180)) so bauen,
    dass es **`%no-protection` statt der `Passphrase: …`-Zeile** enthält. **Direktiven-
    Reihenfolge ist load-bearing** (im Analyse-Workflow beobachtet: Keygen schlug bei
    Fehlordnung fehl — **noch kein** Repo-Test) → durch Test absichern (F3). Empfohlene
    Form: Key-Params, dann `%no-protection`, dann `%commit`; **keine** `Passphrase`-Zeile.
  - Den Schlüssel-Export ([cli.ts:211-216](../../src/cli.ts#L211-L216)): `--passphrase-fd 0`
    / Loopback **weglassen** (ein `%no-protection`-Schlüssel exportiert ohne Passphrase) bzw.
    leere stdin.
  - **Lauter Warnhinweis** bei Erzeugung: *„Dieser Schlüssel hat KEINE Passphrase. Er ist
    NUR durch Dateirechte geschützt. Halte `vault.key` aus Backups und aus git heraus.“*
- Der **Default** (`init` ohne Flag) bleibt exakt wie heute (Passphrase erforderlich,
  inkl. leerer-Wert-Abbruch).

**F2 — `onboard`-Parität für passphrasenlose Vaults (Komplexität: S)**
- `cmdOnboard` ([cli.ts:381-433](../../src/cli.ts#L381-L433)) darf bei einem
  `%no-protection`-Schlüssel **nicht** am Passphrase-Prompt scheitern
  ([cli.ts:407-412](../../src/cli.ts#L407-L412)). Über das **`--no-passphrase`-Flag**:
  den Passphrase-Schritt überspringen und die Entschlüsselung via `listKeys` **ohne**
  gesetztes `FIO_VAULT_PASSPHRASE` verifizieren.
- **Keine Auto-Erkennung** (ursprünglich erwogen, dann verworfen — siehe §10): ein
  Decrypt-Probe liest den **gpg-agent-Cache** und labelt ein passphrasen-geschütztes
  Key bei warmem Agent (Cache-TTL ~600s; `init`/`set` wärmen ihn) fälschlich als
  „no-passphrase“. Das explizite Flag ist der einzige verlässliche, ehrliche Trigger.
- Die Abschluss-Anleitung ([cli.ts:426-429](../../src/cli.ts#L426-L429)) für diesen Fall
  anpassen: **nicht** auffordern, `FIO_VAULT_PASSPHRASE` in die Shell-Config zu exportieren.

**F3 — Tests (Komplexität: S–M)** — Bestandsmuster (`bun:test`, `spyOn` auf `gpg`,
Temp-Dirs, `global: false`):
- `init --no-passphrase` erzeugt einen **`%no-protection`**-Schlüssel (Batch-Input
  enthält die Direktive, **keine** `Passphrase`-Zeile; korrekte Reihenfolge).
- Default-`init` lehnt eine **leere** Passphrase weiterhin ab (Regression-Guard).
- `exec` / `loadSecrets` gelingen **headless mit `FIO_VAULT_PASSPHRASE` unset** gegen
  einen passphrasenlosen Schlüssel (An-/Abwesenheit der env-Var korrekt an `decrypt`
  durchgereicht).
- `onboard` gegen einen passphrasenlosen Schlüssel: kein Dead-End, Verifikation grün.

**F4 — Skill-, Doku- & PRD-Rewrite (Komplexität: M)**
- `skill/SKILL.md`, `skill/references/agent-safety.md`, `skill/references/workflows.md`,
  `README.md`, `CLAUDE.md`:
  - **Führend** das Wrapper-Muster (Tier 1); `exec` zum **Notausgang** (Tier 2) demoten.
  - Das `loadSecrets()`-Framing korrigieren (KI-authored-ad-hoc = schlecht vs.
    KI-invoke-static-script = best — §4).
  - `init --no-passphrase` als expliziten Unattended-VPS-Modus dokumentieren, **mit**
    dem ehrlichen At-Rest-Caveat (Dateirechte = Grenze; Backup-/git-Hygiene;
    passphrasen­geschützt bleibt Default).
  - Den falschen Eindruck korrigieren, der **einzige** Unattended-Weg sei
    `FIO_VAULT_PASSPHRASE`.
- `CHANGELOG.md` + `package.json` **0.2.0 → 0.3.0** (additiv, opt-in).

### Bewusst verschoben (NICHT Teil dieses Fixes)

- `loadSecrets({ only })` und `withSecrets(keys, fn)` — Ergonomie/Blast-Radius-Hygiene,
  **kein** Sicherheits-Control (im Same-User-Modell ist der ganze Vault per Definition
  erreichbar). Bereits als Phase-2-Could-have in PRD 0001 §5 notiert.
- `init`-Zeit-Scaffolding (Wrapper-Stub generieren).
- `fio-vault doctor --fix` (Stale-Lock-Recovery) — orthogonal, siehe
  [docs/prd-gpg-lock-recovery.md](../prd-gpg-lock-recovery.md).

→ Ein einziges opt-in Flag zuerst ausliefern; Ergonomie separat.

---

## 6. API / Schnittstellen

### CLI

```
fio-vault init [--no-passphrase] [--global] [--cwd <p>]        # NEU: --no-passphrase
fio-vault onboard [--no-passphrase] [--global] [--cwd <p>]     # NEU: Parität (F2)
```

Alle übrigen Befehle unverändert. Das neue Flag muss in der `parseArgs`-Optionsliste
([cli.ts:493-500](../../src/cli.ts#L493-L500)) registriert werden (sonst wirft
`strict`). **Kein** neues Env-Var, **keine** Decrypt-Signal-Variable.

### Datenmodell

**Keine Änderung am Vault-Format** (`manifest.json` + `*.gpg` + `.gpg-id` + `vault.key`).
Der Unterschied liegt allein in der **Schutzeigenschaft des privaten Schlüssels** im
Keyring/`vault.key` (`%no-protection`), nicht in einer neuen persistenten Struktur.

---

## 7. Ops auf dem VPS (Deliverable: dokumentierter Runbook-Abschnitt)

1. **Schlüssel ohne Passphrase anlegen:** `fio-vault init --no-passphrase`. Für einen
   **bestehenden** Vault einmalig die Passphrase auf leer ändern —
   `gpg --batch --pinentry-mode loopback --passphrase '<alt>' --change-passphrase <key-id>`
   (neue Passphrase leer) — und `vault.key` neu exportieren. **Kein** Re-Encrypt der
   Secrets nötig (gleicher Schlüssel, nur ungeschützt).
2. **Dateirechte sperren — jetzt DIE Sicherheitsgrenze (Pflicht, nicht optional):**
   `chmod 600 vault/vault.key`; `chmod 700 ~/.gnupg` und `~/.gnupg/private-keys-v1.d`;
   Repo-Root/Vault-Dir nicht group/world-readable; alles im Besitz des einen Deploy-Users.
   *Ist die Box nicht echt Single-User → stopp, nimm einen separaten OS-User.*
3. **Nichts ins Environment setzen:** jedes `export FIO_VAULT_PASSPHRASE=…` aus
   `~/.zshrc`/`~/.bashrc`, systemd `Environment=`/`EnvironmentFile` und cron-Headern
   entfernen. Die Abwesenheit ist der Punkt.
4. **Schlüssel einmal importieren:** `fio-vault onboard --no-passphrase` (oder
   `gpg --batch --import vault/vault.key`) — kein interaktiver Schritt nötig.
5. **AI-Entry-Points auf Wrapper verdrahten:** `package.json`-Scripts / `bin/*`-Wrapper
   pro wiederkehrendem Task; Long-running-Apps rufen `loadSecrets()` bei Boot; cron-Jobs
   rufen ein Skript, das den Secrets-Loader importiert — keine Passphrase-Plumbing im
   crontab.
6. **Backup-/Exfil-Hygiene** (gleicht den einen echten Verlust aus): `vault.key`
   (und `~/.gnupg`) aus jedem Off-Site/synced Backup ausschließen **oder** separat
   verschlüsseln; nie committen — nur `*.gpg` + `manifest.json` + `.gpg-id`;
   `vault.key` in `.gitignore`.
7. **Unbeaufsichtigt smoke-testen:**
   `ssh vps 'cd app && unset FIO_VAULT_PASSPHRASE; fio-vault exec -- node -e "process.exit(process.env.SOME_KEY?0:1)"'`
   → Exit 0, kein Prompt, kein Hang. `fio-vault get <key>` aus Non-TTY muss weiter `3`
   liefern (Guard intakt). cron-Exit-Codes monitoren — `exec` schlägt hart fehl statt ein
   Child ohne Secrets zu starten, also auf Non-Zero alerten.

---

## 8. Nicht-funktionale Anforderungen & Residual-Vektoren

- **Sicherheit (Scope = Versehen):** Roh-Wert nie zur KI; passphrasenloser Modus opt-in
  + lauter Hinweis; Dateirechte explizit als Grenze benannt.
- **Kompatibilität:** vollständig **additiv**. Bestehende passphrasen­geschützte Vaults
  bleiben unverändert; `init`/`onboard` ohne Flag verhalten sich exakt wie in 0.2.0.
  **Kein** Breaking Change. Version 0.2.0 → 0.3.0.
- **Performance/Portabilität:** unverändert; kein systemd/Socket/Agent-Warming nötig.

**Residual-Vektoren (ehrlich):**
- **Env-Dump vom gewählten Child** (`env`/`printenv`/Debug-Logger) und ad-hoc Skripte,
  die `console.log(process.env.SECRET)` schreiben — eine **Disziplin-Grenze** in *jedem*
  Modell (Same-User ⇒ Wert per Definition erreichbar). Wrapper **verkleinern** die Fläche,
  eliminieren sie nicht.
- **Namens-Exposition beim Editieren** des Wrappers: die „KI nennt keinen Token“-Garantie
  gilt im Steady-State-Invoke-Flow; während die KI `scripts/sync.ts` **schreibt/editiert**,
  sieht sie die Namen in der Source. Begrenzt, nicht absolut.
- **Off-Box-Schlüssel-Exposition** — der eine echte Preis des Passphrase-Verzichts. Ein
  geleaktes Backup/Snapshot oder versehentlicher `git push` von `vault.key` ergibt einen
  direkt nutzbaren Schlüssel. **Operativ** mitigiert (§7.2/§7.6), **nicht** kryptografisch
  — genau deshalb ist `--no-passphrase` **opt-in pro Vault**, nie Default, mit lautem
  Hinweis bei Erzeugung.

**Explizit out of scope (nicht over-engineeren):** bösartiger Same-User (eigener OS-User
nötig), Multi-User/Multi-Tenant/NFS (separater OS-User, ggf. age/Broker darüber),
Audit-Logging „wer entschlüsselte was“ (Broker-Territorium, null Gewinn gegen Versehen).

---

## 9. Projektstruktur (geänderte/neue Dateien)

```
src/
  cli.ts            # erweitert: --no-passphrase in parseArgs; cmdInit (%no-protection-Zweig,
                    #            Export ohne Loopback, Warnhinweis); cmdOnboard-Parität
  (gpg.ts, vault.ts, exec.ts, manifest.ts, utils.ts, types.ts UNVERÄNDERT)
src/__tests__/
  cli-init.test.ts  # NEU/erweitert: %no-protection-Erzeugung, Default lehnt leer ab,
                    #                headless decrypt ohne env-Var, onboard-Parität
skill/
  SKILL.md                       # Wrapper-first; exec als Notausgang; --no-passphrase
  references/agent-safety.md     # loadSecrets()-Framing korrigiert; At-Rest-Caveat
  references/workflows.md        # Wrapper-Setup + Unattended-VPS-Runbook
docs/
  prd/0002-unattended-vps-no-passphrase.md   # dieses Dokument
  explainer/fio-vault-flow.html              # visuelle Erklärung (bereits erstellt)
README.md           # Wrapper-Muster, --no-passphrase, Unattended-VPS-Abschnitt
CLAUDE.md           # Befehlsliste + Regel: Wrapper > exec; --no-passphrase opt-in
CHANGELOG.md        # 0.3.0-Eintrag (additiv, opt-in)
package.json        # version 0.2.0 → 0.3.0
```

**Konventionen (Bestand):** alle Shell-Calls via `Bun.spawn`; GPG-Batch-Input
sanitisiert ([cli.ts:157](../../src/cli.ts#L157)); Key-Namen gegen Path-Traversal;
Manifest gegen Prototype-Pollution.

---

## 10. Offene Punkte & Default-Entscheidungen

| Punkt | Vorgeschlagener Default | Begründung |
|---|---|---|
| `onboard`: explizites `--no-passphrase`-Flag oder Auto-Erkennung? | **Nur Flag** (Auto-Erkennung verworfen) | Ein Decrypt-Probe liest den gpg-agent-Cache und labelt bei warmem Agent ein passphrasen-geschütztes Key fälschlich als „no-passphrase“ (empirisch reproduziert, GnuPG 2.5.19). Eine cache-immune Prüfung (keygrip-Datei-Inspektion) wäre korrekt, aber ~40 Zeilen brüchige GPG-Interna für einen reinen Komfort-Pfad — nicht gerechtfertigt. Das explizite Flag ist verlässlich und ehrlich. |
| `init --no-passphrase` zusätzlich interaktiv bestätigen lassen? | **Nein** — nur lauter Hinweis nach Erzeugung | Das Flag ist bereits die bewusste Geste; ein zweiter Prompt nervt im Automations-Kontext. |
| `%no-protection`-Direktiven-Reihenfolge | Key-Params → `%no-protection` → `%commit`; **durch F3-Test abzusichern** | Im Analyse-Workflow beobachtet: Fehlordnung führte zu Keygen-Fehler (noch kein Repo-Test). |
| `decrypt()`/`gpg.ts` anfassen? | **Nein** | Im Analyse-Workflow manuell verifiziert unnötig (§3), F3 verankert es als Test; kleinste korrekte Änderung. |
| `loadSecrets({ only })` / `withSecrets()` mitliefern? | **Nein** (Phase 2) | Ergonomie, kein Sicherheits-Control; hält diesen Change auf ein Flag fokussiert. |
| Bestehender Vault: konvertieren oder neu? | **Konvertieren** (`--change-passphrase` auf leer) | Kein Re-Encrypt nötig; selber Schlüssel. |

---

## Anhang — Phasen-Roadmap

1. **Phase 1 (dieses PRD):** `init --no-passphrase` + `onboard`-Parität + Tests +
   Wrapper-first-Doku. Behebt VPS-Friktion vollständig, ohne Decrypt-Code-Change. SemVer 0.3.0.
2. **Phase 2 (Could):** `loadSecrets({ only })`, `withSecrets(keys, fn)`, `init`-Zeit-
   Wrapper-Scaffold, `fio-vault doctor --fix` (orthogonal).

**Bewusst nicht auf der Roadmap:** Broker-Daemon / eigener User / age-Backend (siehe §2
verworfene Alternativen — nur mit verschobenem Threat-Model relevant).
