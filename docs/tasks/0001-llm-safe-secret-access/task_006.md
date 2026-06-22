# Task 006: Harvester-Migration auf `exec` (extern, anderes Repo)

## Dependencies
- Requires: Task 002 (`fio-vault exec`, ausgeliefert in 0.2.0)

## Description
(PRD §5 F4)

> **Liegt im externen Repo `lead-harvester-monorepo`, NICHT im fio-vault-Repo** —
> kein Teil des mergebaren fio-vault-Phase-1-Codes. Referenz/Folgeschritt.

Konkrete Migrationsziele:
- `scripts/poc/booking-poc.ts` (`getApifyToken()`, ruft `spawnSync` `fio-vault get` —
  bricht nach dem neuen Guard in non-TTY mit Exit `3`).
- Agent-Memory `CLAUDE.md` (lehrt weiter `APIFY_API_TOKEN="$(fio-vault get …)"`).

Bevorzugter Pfad: `fio-vault exec --only apify-api-token -- <cmd>`.

## Expected Outcome
- Harvester-Skripte/Doku nutzen `fio-vault exec` statt der `get`-Subshell.
- (Umsetzung + Akzeptanz im Harvester-Repo.)

## Agent Context
Anderes Repo (`~/workspace/marketing/lead-harvester-monorepo`); benötigt das in
fio-vault **0.2.0** (Task 002) ausgelieferte `exec`. Separat/nachgelagert ausführen —
**nicht** im fio-vault-Repo committen.
</content>
