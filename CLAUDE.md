# ioBroker.truenas — Projekt-Kontext

**Eigentümer:** Meister | **Repo:** `vie.preindl.at/git/richie/iobroker.truenas` (noch anzulegen)
**Ziel:** ioBroker-Adapter für TrueNAS SCALE (Pool-Status, SMART, Temperaturen/Fan, Dataset-Nutzung) — echter npm-Adapter, kein Userscript.
**Konzept + Recon:** noch kein Issue — vor dem Scaffolding zuerst anlegen (siehe `LESSONS-LEARNED.md` Abschnitt 1.1/2).
**Bauprozess:** `LESSONS-LEARNED.md` — aus dem Bau von `iobroker.wdmycloud` (davor `iobroker.freshtomato`) destilliert, unbedingt vor dem Scaffolding lesen.

---

## Wichtiger Unterschied zum Hauptprojekt (`Iobroker`-Repo)

Das hier ist **kein Userscript** (`javascript`-Adapter, `Scripts/*.js`), sondern ein **echter ioBroker-Adapter** — eigenständiges npm-Paket mit eigener `io-package.json`, `package.json`, Objekt-Struktur (`device → channel → state`), CI. Andere Konventionen, anderer Bauprozess als das Hauptprojekt. Analog zu `iobroker.freshtomato`/`iobroker.wdmycloud` — dort ist der Referenzprozess bereits zweimal durchexerziert.

---

## Ausgangslage (Stand 15.09.2026)

Recherche in einer anderen Session (homelab-Repo) hat bestätigt: **es gibt
keinen existierenden ioBroker-Adapter für TrueNAS** — geprüft npm-Registry
(`iobroker.truenas`, `iobroker.freenas`), ioBroker-Adapter-Suche, Forum/GitHub
(nur Threads zu "ioBroker in einer TrueNAS-Jail laufen lassen", keine
Integration die TrueNAS ansteuert).

**Nützlicher Baustein:** `@truenas/api-client` (npm) — offizieller,
framework-agnostischer TypeScript-Client für die TrueNAS
JSON-RPC-2.0-WebSocket-API. Naheliegende Basis statt eigenes
API-Parsing/SSH-Scraping.

---

## Zielgerät

| Name | Host | Modell | API |
|---|---|---|---|
| PR4100 | `truenas.preindl.local` (192.168.1.115) | WD PR4100, TrueNAS SCALE | JSON-RPC 2.0 über WebSocket (`@truenas/api-client`) |

Nur **ein** Zielgerät bisher (anders als bei `wdmycloud` mit zwei
Firmware-Varianten) — Abschnitt 2 der `LESSONS-LEARNED.md` trotzdem lesen,
das Grundprinzip ("gegen das echte Gerät messen, nicht annehmen") gilt
unabhängig von der Gerätezahl.

Relevante Datenpunkte aus der bisherigen Handarbeit auf diesem Host (siehe
`scripts/nas/pr4100-hwctl.sh` im homelab-Repo, falls Zugriff besteht):
CPU-Temp, PMC-Board-Temp, Fan-RPM/-Speed, NVMe-Boot-SSD-Temp, Disk-Temps
(SMART), Pool-Nutzung/Health. Das war Handarbeit über SSH+PMC-Serial-Protokoll
— der neue Adapter soll das über die offizielle API sauber abbilden, nicht
den seriellen Hack wiederverwenden.

---

## Credentials

Test-Zugangsdaten (sobald vorhanden) nach Repo-Konvention in
`/home/richie/credentials/truenas-<zweck>.credentials` (Ordner `0700`,
Dateien `0600`), nicht im Repo. Bereits vorhanden für SSH-Zugriff:
`/home/richie/.ssh/id_ed25519` (User `claude-ai`) — für die API braucht es
vermutlich einen eigenen API-Key (TrueNAS-Web-UI → API Keys), nicht
denselben wie SSH.

---

## Stand

Noch kein Adapter-Code, noch kein Forgejo-Repo — reine Vorbereitungsphase.
Nächste Schritte: Repo anlegen, Konzept-/Recon-Issue #1 (Zielgerät, API-Auth,
geplante Datenpunkte), danach erst `@iobroker/create-adapter`-Scaffolding.
