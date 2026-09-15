# ioBroker-Adapter bauen — Leitfaden

Destilliert aus dem Bau von `iobroker.freshtomato` (Referenzimplementierung)
und `iobroker.wdmycloud` (zweiter Adapter, gebaut nach demselben Muster).
Ziel: bei jedem neuen Adapter als Ausgangspunkt lesen — **besonders Abschnitt
4 und 6**, dort stecken die Fehler, die bei `wdmycloud` erst nachträglich
gefunden und korrigiert werden mussten, obwohl sie 1:1 aus der
"funktionierenden" Referenz `freshtomato` übernommen waren.

Kernlektion über allem: **"kopiert aus dem Referenzprojekt" ist keine
Garantie, dass es funktioniert.** Mehrere Bugs in diesem Dokument steckten
unentdeckt auch in `freshtomato` — sie fielen erst auf, weil `wdmycloud`
tatsächlich live im Browser gegen eine echte Admin-Instanz getestet wurde.
Ohne diesen Live-Test wären sie in beiden Adaptern für immer unbemerkt
geblieben.

---

## 1. Vor dem Scaffolding: Recon-Phase

Bevor auch nur eine Zeile Code geschrieben wird, ein Konzept-Issue anlegen
mit:

- Zielgeräte (mind. 2, wenn möglich — siehe Abschnitt 2, warum)
- Protokoll-Endpunkte, so weit bekannt (Login, Kern-Datenpunkte, optionale
  Stretch-Datenpunkte), mit Quelle (Referenzprojekt, eigener Recon)
- Bekannte Fallstricke (z. B. Session-Limits, fehlendes HTTPS auf manchen
  Geräten)
- Referenzprojekte klar als **Protokoll-Dokumentation, nicht als
  Code-Quelle** kennzeichnen — nicht portieren, in JS neu bauen, im README
  kreditieren

`@iobroker/create-adapter` erst NACH dieser Recon-Phase laufen lassen.
Antworten in `.create-adapter.json` sichern (Reproduzierbarkeit). Das
KI-generierte Grundgerüst nicht von der KI umschreiben lassen — nur die
Logik danach.

---

## 2. Gegen mehrere Zielgeräte verifizieren, nicht nur das best-dokumentierte

Jede Kern-Annahme (Login-Flow, XML-/JSON-Struktur, Feldnamen,
Endpunkt-Verfügbarkeit) gegen **alle** Zielgeräte prüfen, nicht nur gegen
das offiziell unterstützte / am besten dokumentierte.

Konkrete Beispiele, wo Geräte voneinander abwichen:
- `freshtomato`: `porta` vs. `porta-keller` — unterschiedliche
  HTTP-IDs/Timeouts nötig
- `wdmycloud`: EX2 Ultra (offiziell unterstützt, HTTPS) vs. Chronos
  (RangerPeak-Plattform, nicht offiziell gelistet, kein HTTPS, `cmd=
  cgi_get_uptime` gibt HTTP 500 zurück wo `cmd=cgi_get_status` funktioniert)

Bei mehrdeutigen Fehlern: isolierten Minimalfall bauen, bevor man einer
Theorie hinterherjagt. Ein pauschaler Fehlertext, der für 95 % der Fälle
stimmt, kann bei einem Sonderfall komplett in die Irre führen (Beispiel
`freshtomato`: "leerer Body → falsche HTTP-ID" traf auch auf einen Router
ohne USB-Unterstützung zu, aus einem ganz anderen, harmlosen Grund).

---

## 3. Kern-Implementierungsmuster

- **Client-Modul** (`lib/*-client.js`): eigene Klasse, Login/Logout,
  Session-Cookie-Handling, Single-Flight-Login (`this.loginPromise`) gegen
  Race Conditions, wenn mehrere parallele Requests beim ersten Login
  gleichzeitig `login()` aufrufen könnten
- **Objektbaum**: `device → channel → state`, `setObjectNotExistsAsync`,
  `ack:true` für gemeldete Werte
- **Session-Limits einzelner Geräte ernst nehmen**: erlaubt ein Gerät nur
  eine aktive Session geräteweit (nicht pro Account), nach jedem Poll-Zyklus
  aktiv ausloggen statt die Session bis zum Timeout zu halten — sonst
  blockiert der Adapter das eigene Web-Dashboard des Geräts
- **XML-Parsing-Fallstricke** (`fast-xml-parser`): `ignoreDeclaration: true`
  setzen, sonst landet die `<?xml?>`-Prolog-Deklaration als falscher
  Root-Key; `isArray`-Callback für Felder setzen, die mal einzeln, mal als
  Liste auftreten (sonst bricht Code, der `.map()` auf ein Einzelobjekt
  aufruft)
- **Undokumentierte Endpunkte per Reverse-Engineering** sind legitim, wenn
  Referenzprojekte nichts hergeben: Request im Browser-DevTools-Network-Tab
  des Geräte-eigenen Dashboards mitschneiden (Request-URL, Methode, **volle
  Request-Headers inkl. Payload/Body** — ein Screenshot der gerenderten
  HTML-Tabelle reicht nicht, das ist nur das Ergebnis, nicht der Request).
  Exakt denselben Request nachbauen, nicht "vereinfachen" (z. B. Parameter
  weglassen, die harmlos aussehen) — das genaue Muster ist nachweislich
  sicher, eine Abwandlung ist wieder Rätselraten. Risiko im README
  dokumentieren: kann mit Firmware-Update brechen, Fehler isoliert
  behandeln (siehe Abschnitt 4).

---

## 4. Testing- und Packaging-Disziplin (hier steckten die wdmycloud-Fehler)

### 4.1 `common.messagebox` — kritischster Fund dieser Session

Jeder Adapter, der `onMessage`/`sendTo` nutzt (z. B. für ein
`selectSendTo`-Dropdown in der Admin-UI, etwa zur Auswahl einer
InfluxDB-Instanz), **braucht `"messagebox": true` in `io-package.json`
unter `common`**. Ohne dieses Flag routet js-controller gar keine
`sendTo`-Nachrichten an den Adapter — der Code ist korrekt, die Nachricht
kommt aber nie an. Symptom: das Dropdown-Feld in der Admin-GUI zeigt einen
endlos drehenden Spinner, keine Fehlermeldung, kein Log-Eintrag, keine
Netzwerk-Aktivität für den erwarteten `sendTo`-Call.

**Dieser Fehler steckte identisch in `freshtomato`** (dort nie live in
einem Browser getestet) und wurde nur entdeckt, weil `wdmycloud`s
InfluxDB-Dropdown tatsächlich im Admin-UI geöffnet wurde. Diagnoseweg, falls
das nochmal auftritt: DevTools → Network-Tab, nach dem Command-Namen
filtern (z. B. `getInfluxInstances`) — kommt dort **gar keine** Anfrage,
nicht mal eine mit Fehlerantwort, ist `messagebox` der erste Verdächtige.
DevTools → Elements/Inspect auf die leere Stelle zeigt dann typischerweise
ein `MuiCircularProgress` (endloser Spinner), das nie auflöst.

**Regel:** Jedes `selectSendTo`/`autocompleteSendTo`-Feld in
`admin/jsonConfig.json` erfordert automatisch `messagebox: true` — beim
Hinzufügen eines solchen Feldes sofort mitsetzen, nicht erst wenn der Bug
auffällt.

### 4.2 `npm pack` vor JEDEM Release prüfen

`package.json`s `files`-Array muss Testdateien explizit ausschließen:
`"!lib/**/*.test.js"` neben dem `"lib/"`-Eintrag. Fehlt das, landen
`*.test.js`-Dateien im veröffentlichten npm-Paket — bei `wdmycloud` geschah
genau das bei Version 0.8.0 (Release musste sofort durch 0.8.1 ersetzt
werden, alter Tag/Release wieder gelöscht).

**Regel:** vor jedem `git tag`/Release **immer** `npm pack` laufen lassen
und den Tarball-Inhalt tatsächlich prüfen (`tar -tzf *.tgz | grep -i test`
sollte leer sein), nicht nur die Tests laufen lassen. Test-Suite grün sagt
nichts über Paket-Inhalt aus.

### 4.3 ESLint-Ignore-Pattern für verschachtelte Testdateien

`eslint.config.mjs`s `ignores`-Liste mit `'*.test.js'` matcht **nur
Root-Level-Dateien**, nicht `lib/irgendwas.test.js`. Richtig:
`'**/*.test.js'`. Symptom bei falschem Pattern: `lib/*.test.js` wird mit den
Produktionscode-Regeln gelintet (z. B. `no-undef` auf `describe`/`it`, weil
die Mocha-Globals fehlen) statt ignoriert zu werden.

### 4.4 Vollständiger Test-Lauf vor jedem PR

`npm test` (unit + package-Validierung) und `npm run lint` (0 Fehler,
Warnungen bei bestehendem JSDoc-Fehlbestand tolerierbar, aber keine neuen
einführen) — beides grün, bevor ein PR eröffnet wird. Nach jedem
`eslint --fix` die Tests erneut laufen lassen (Formatierungs-Fixes können in
Ausnahmefällen Verhalten verändern).

### 4.5 Live-Verifikation vor Merge, nicht nur Unit-Tests

Neue Features gegen echte Hardware testen, **durch das tatsächliche
Client-Modul**, nicht nur per rohem HTTP-Probe-Skript — ein Probe-Skript
kann funktionieren, während der eigentliche Adapter-Code einen anderen
Session-/Header-Umgang hat. Mehrfach in dieser Session bestätigt: Annahmen
("Firmware-Check braucht einen asynchronen Endpoint", "SMART-Daten sind
nicht verfügbar") waren falsch, bis tatsächlich live gegen das Gerät
getestet wurde.

---

## 5. PR-/Review-/Release-Workflow

1. Feature-Branch → PR
2. `@gemini-bot review` (triggert automatisch beim Anlegen des PR, danach
   **nicht mehr automatisch** — nach jedem weiteren Push manuell mit einem
   Kommentar `@gemini-bot review` erneut anstoßen)
3. Bot-Befunde **gegen den echten Code prüfen**, nicht blind übernehmen —
   der Bot lag mehrfach nachweislich falsch oder schlug Änderungen vor, die
   einer bewussten Design-Entscheidung widersprachen (z. B. kein
   Disable-on-Unload für InfluxDB-Logging: absichtlich so, wegen
   Restart-Churn, nicht übersehen)
4. Zusätzlich eigene manuelle Code-Review-Runde, auch wenn der Bot nichts
   Kritisches findet — in dieser Session fand die manuelle Runde 2 echte
   Bugs (Tracking-Verlust bei InfluxDB-Instanzwechsel, fehlende Datenreihe
   im Grafana-Dashboard) und 2 Doku-Ungenauigkeiten (unverifiziert aus
   freshtomato kopierte Behauptungen), die der Bot nicht als blockierend
   markiert hatte
5. Merge, Branch löschen
6. Versions-Bump: **Minor für Features, Patch nur für Fixes** (Semver-
   Disziplin, nicht wie bei den allerersten freshtomato-Versionen)
7. Git-Tag + Forgejo-Release, npm-Tarball als Release-Asset hochladen
   (`npm pack`, dann per Forgejo-API mit Multipart-Upload anhängen)
8. Upgrade-Anleitung für Testinstanzen geben (`curl -u <user> -o ... `,
   `npm i`, `iob upload`, `iob restart`) — Instanz-Start/Stop/Restart nie
   selbst per REST ausführen (siehe Abschnitt 6.1)

---

## 6. Harte Sicherheitsregeln

### 6.1 Niemals `system.adapter.*`-Objekte per REST beschreiben

`protectedNative`-Felder (Passwörter, Tokens) werden von `GET` **nie**
zurückgegeben — nicht als `null`, sondern als komplett fehlender Key. Ein
naiver Ablauf "GET holen, ein Feld ändern, alles per PUT zurückschreiben"
löscht das Passwort, weil `JSON.stringify` die fehlende Property gar nicht
erst mitschreibt und `PUT` das `native`-Objekt vollständig ersetzt — auch
wenn `native` im PUT-Body komplett weggelassen wird (funktioniert nur auf
Wegwerf-Testobjekten, nicht auf echten `system.adapter.*`-Instanzen).

**Regel:** Instanz-Start/Stop/Restart/Config-Änderungen immer den Nutzer
selbst machen lassen (Admin-UI oder eigener SSH-Zugriff). Für Fixes wie
"Host-Feld korrigieren" nur eine Anleitung geben, nicht selbst schreiben.

### 6.2 REST-API-Eigenheiten (gilt für jede test-`rest-api`/`simple-api`-Instanz)

- `?pattern=`-Filter auf `/v1/objects` ist unzuverlässig — immer den
  kompletten Objektbaum holen und clientseitig nach exaktem ID-Präfix
  filtern
- `/v1/objects` (Bulk-Endpoint) liefert oft **nur States**, keine
  Instance-/Channel-/Device-Objekte mit `common`-Metadaten (Version, Icon
  etc.) — dafür den Singular-Endpoint `/v1/object/<id>` verwenden

### 6.3 GitHub-Mirror — vollständiger Sicherheitsprozess

**Leitregel, vor jedem Sync:** Drei Kategorien dürfen unter keinen
Umständen auf den öffentlichen Mirror gelangen — (1) sensible Daten
(private E-Mails, echte interne IPs, Geräte-Rohdaten/Spitznamen), (2)
Claude/Assistenten-spezifische Dateien (`CLAUDE.md`, `LESSONS-LEARNED.md`,
`AGENT-MEMORY.md`, `ADAPTER-BUILD-GUIDE.md`, KI-Attribution-Trailer in
Commit-Messages), (3) Credentials (Zugangsdaten selbst leben ohnehin nie
im Repo, sondern extern unter `/home/richie/credentials/` — hier geht es
um Datei*pfade*, die auf sie verweisen, z. B. in `test/integration.js`,
und die trotzdem generalisiert werden müssen). Die Checkliste unten setzt
das im Detail um; bei Unsicherheit, ob etwas in eine dieser drei
Kategorien fällt, im Zweifel ausschließen statt riskieren.

**Nie pushen ohne explizite, separate Freigabe** — Vorbereiten und lokal
committen ist jederzeit ok, der tatsächliche `git push` zum öffentlichen
Remote braucht bei jedem Mal eine neue, ausdrückliche Bestätigung.

**Struktur:** `git checkout --orphan github-mirror`, ein einziger
geflatteter Commit pro Sync (keine private Detail-Historie), bei jedem
weiteren Sync: `git checkout main -- .` (aktuellen privaten Stand holen),
dann komplette Sanitisierung erneut anwenden (Sanitisierung überlebt
`checkout main -- .` nicht, muss jedes Mal neu laufen).

**Sanitisierungs-Checkliste, bei JEDEM Sync:**

1. `CLAUDE.md`, `LESSONS-LEARNED.md`, `AGENT-MEMORY.md` (und diese Datei)
   komplett entfernen — keine Sanitisierung, kein Redigieren, immer
   vollständige Entfernung. Gilt für jede Datei, die Assistenten-internes
   Session-Gedächtnis exportiert, auch falls später anders benannt.
2. Echte private E-Mail-Adresse überall ersetzen (io-package.json authors,
   package.json author, LICENSE, README-Copyright) — z. B. durch eine
   `users.noreply.github.com`-Adresse
3. Echte interne IPs durch generische Platzhalter ersetzen (z. B.
   `192.168.1.50` statt der echten Geräte-IP, oder RFC-5737/TEST-NET-Ranges
   für Beispiele in Configs)
4. Private Geräte-Spitznamen/Hostnamen generalisieren (z. B. "Chronos" →
   "RangerPeak-basierte Geräte") — **bei jedem Sync neu grep'en**, nicht nur
   die aus dem letzten Durchlauf bekannten Stellen ersetzen. Neuer Code
   bringt neue Erwähnungen mit, die vorherige Sync-Läufe nicht kannten.
5. Echte Geräte-Rohdaten (Seriennummern, RAID-/Volume-UUIDs, Modell+Serial-
   Kombinationen), die während der Live-Entwicklung aus echten XML/JSON-
   Dumps kopiert wurden, dürfen **nie** in Doku/Code/Kommentare wandern —
   nur generische Platzhalterwerte
6. `test/integration.js`: Live-Device-Testsuite (referenziert echte
   Credentials-Dateipfade und echte IPs) durch die sichere
   Placeholder-only-Suite ersetzen — bei jedem Sync neu, nicht nur einmalig
7. Abschließender Grep-Sweep über den gesamten Baum nach allen obigen
   Mustern, bevor committed wird
8. Vollen Testlauf (`npm run test:package` mind.) auf dem sanitisierten
   Branch laufen lassen — Sanitisierungs-`sed`-Befehle können stillschweigend
   JSON/Text kaputt machen (z. B. doppelte Wörter durch überlappende
   Ersetzungen)

**Git-Tags sind repo-weit, nicht branch-spezifisch — kritische Falle:**

Ein Tag-Name existiert nur einmal pro Repository, unabhängig vom Branch. Wird
z. B. `v0.9.0` zuerst auf dem privaten `main`-Branch angelegt und später
versucht, denselben Namen auf `github-mirror` neu zu vergeben, schlägt
`git tag -a` mit "Tag existiert bereits" fehl — ein nachfolgender
`git push <tagname>` kann dann **den alten Tag** pushen, der auf den
privaten Commit zeigt, und zieht dessen komplette erreichbare Historie
(alle Objekte: Blobs, Trees, Commits) ins öffentliche Repo, obwohl nie
beabsichtigt war, `main` zu veröffentlichen. Genau das ist in dieser Session
passiert.

**Regel:** nach jedem `git tag -a` sofort mit
`git rev-parse <tag>^{commit}` gegen `git rev-parse <erwarteter-branch>`
prüfen, dass der Tag auf den richtigen Commit zeigt — **bevor** er gepusht
wird. Bei Namenskollision: alten Tag lokal löschen (`git tag -d`), neu
gegen den korrekten Branch-Head erstellen.

**Nach einem Leak — was ein Ref-Delete tatsächlich bewirkt:**

Ein gelöschter Tag/Branch-Ref entfernt die Sichtbarkeit beim normalen
Browsen/Klonen, **löscht aber nicht sofort die zugrunde liegenden Objekte**.
Diese bleiben per direktem SHA (z. B. über die GitHub-API
`/repos/.../commits/<sha>`) abrufbar, bis GitHub sein Garbage Collection
durchführt — nicht sofort, nicht selbst auslösbar. Für reine Interna
(private IPs, interne Hostnamen, Prozess-Doku) ist das ein begrenztes
Restrisiko. **Für echte Secrets (Passwörter, Tokens) gilt: sofort rotieren,
nicht auf GC warten** — und ein GitHub-Support-Ticket für eine garantierte
Objekt-Löschung ist nur vom Account-Owner selbst stellbar, nicht per API.

**Commit-Message-Hygiene im öffentlichen Mirror:**

KI-Attribution-Trailer (`Co-Authored-By: Claude ...`, Session-Links), die
im privaten Forgejo-Repo Standard sind, gehören **nicht** in die
öffentlichen Mirror-Commits — Referenzprojekt-Konsistenz vor jedem Sync
prüfen (`git log <referenz-repo>/github-mirror --format="%B"` vergleichen),
nicht nur den eigenen privaten Commit-Stil kopieren. Bereits gepushte
Trailer lassen sich nur per `git filter-branch --msg-filter` (oder
vergleichbar) rückwirkend entfernen, plus Force-Push — betrifft dieselbe
GC-Restrisiko-Regel wie oben.

**GitHub-Contributors-Anzeige ist kein verlässlicher Sicherheits-Check:**

Die "Contributors"-Seitenleiste zeigt nur Commits, deren Autoren-E-Mail mit
einem verknüpften GitHub-Account übereinstimmt. Eine nie verknüpfte
E-Mail-Adresse taucht dort **nie** auf, unabhängig von Commit-Anzahl oder
-Inhalt — das ist etwas anderes als "der Name erscheint nicht in der
Commit-Historie" (der erscheint dort weiterhin, nur eben nicht in diesem
einen UI-Widget). Bei einer Exposure-Prüfung beides separat behandeln, nicht
verwechseln.

---

## 7. Kurz-Checkliste für den nächsten Adapter

- [ ] Recon-Issue vor Scaffolding, gegen alle Zielgeräte
- [ ] `.create-adapter.json` sichern
- [ ] `protectedNative`/`encryptedNative` für Passwörter/Tokens
- [ ] Bei jedem `selectSendTo`/`autocompleteSendTo`-Feld: `messagebox: true`
      sofort mitsetzen
- [ ] `package.json` `files`: `!lib/**/*.test.js` (oder Äquivalent) von
      Anfang an
- [ ] `eslint.config.mjs` ignores: `**/*.test.js`, nicht `*.test.js`
- [ ] Vor jedem Release: `npm pack` + Tarball-Inhalt tatsächlich ansehen
- [ ] Neue Features live gegen echte Hardware verifizieren, durchs
      Client-Modul, nicht nur Probe-Skripte
- [ ] PR → Bot-Review (verifizieren, nicht blind übernehmen) → eigene
      manuelle Review-Runde → Merge → Minor/Patch-Bump korrekt wählen
- [ ] GitHub-Mirror: nie ohne explizite Freigabe pushen, volle
      Sanitisierungs-Checkliste bei jedem Sync, Tag-Ziel vor jedem Push
      verifizieren
