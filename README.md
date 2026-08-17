<div align="center">

<img src=".github/hero.png" width="100%" alt="pager" />

<br>

**Kurze Nachrichten aufs Handy. Ohne fremden Dienst dazwischen.**
Ein Passwort, ein Link, und dein iPhone brummt.

<sub>Web Push · PWA statt App Store · kein Apple-Developer-Account · null Abhängigkeiten</sub>

<br>

</div>

<div align="center">

**Personen statt Geräte**  ·  **Apple liest nicht mit**  ·  **Verlauf als Thread**  ·  **ein Befehl zum Aufsetzen**

</div>

<br>

---

<br>

<div align="center">

Ein **Space** ist eine eigene Instanz mit einem Passwort.
Wer drin ist, darf senden. Wer sich anmeldet, kann empfangen.

</div>

<br>

<table align="center" width="100%">
<tr>
<td width="50%" valign="top">

**📨 &nbsp; Ich wurde eingeladen**

Link antippen · **zum Home-Bildschirm** · von dort öffnen · Namen eingeben · erlauben.

Am Rechner reicht der Link. Dann sendest du nur, das genügt oft.

</td>
<td width="50%" valign="top">

**🔧 &nbsp; Ich mache einen Space auf**

```
npm install
npm run setup
```

Schlüssel, Passwort, Datenbank, Deploy — ein Befehl, ein Browser-Login.

</td>
</tr>
</table>

<br>

---

<br>

<div align="center">

Adressiert wird die **Person**. Eine Nachricht an `maximilian kallina` geht an all seine Geräte —<br>
egal ob du sie vom Mac oder vom iPhone schickst. Deshalb ist der Verlauf zwischen zwei<br>
Leuten automatisch ein Thread, ohne dass irgendwo ein Chat gebaut wurde.

</div>

<br>

---

<br>

# Technik

*Wie es gebaut ist, was wo läuft, und welche Entscheidungen dahinterstehen.*

<br>

## Aufbau

Ein einziger Cloudflare Worker liefert **beides** aus: die Seite und die API.
Kein GitHub Pages daneben, kein CORS, kein zweiter Deploy, der synchron bleiben
muss. Statische Dateien werden direkt aus `docs/` bedient und erreichen den
Worker-Code gar nicht erst — nur Pfade ohne passende Datei, also `/api/*`,
laufen durch `worker/index.js`.

```
pager/
├─ worker/
│  ├─ index.js        Router, Auth, Geräte, Senden, Verlauf
│  ├─ push.js         RFC 8291 (aes128gcm) + RFC 8292 (VAPID) — reines WebCrypto
│  └─ schema.sql      D1: devices, messages
├─ docs/
│  ├─ index.html      die ganze App: Gate, Login, Identität, Personen, Threads
│  ├─ sw.js           Service Worker — zeigt die Notification, weckt offene Fenster
│  └─ manifest.webmanifest
├─ setup.mjs          richtet einen neuen Space ein
├─ password.mjs       setzt ein neues Space-Passwort
├─ tools.mjs          gemeinsame Bausteine der beiden Skripte
└─ wrangler.jsonc
```

Rund 1300 Zeilen insgesamt, ohne eine einzige Laufzeit-Abhängigkeit.
`wrangler` ist die einzige devDependency.

<br>

## Wie eine Nachricht läuft

```
Gerät meldet sich an  →  Subscription landet in D1
                             ↓
Du tippst Text  →  Worker verschlüsselt  →  Apple  →  Gerät
                                                        ↓
                                                sw.js zeigt sie an
```

Verschlüsselt wird im Worker, entschlüsselt erst auf dem Gerät. Apple und
Google leiten nur weiter und können nicht mitlesen — das ist keine Zusicherung
von uns, sondern die Bauart von Web Push.

**Das ist ausdrücklich keine Ende-zu-Ende-Verschlüsselung.** Verschlüsselt wird
erst *ab* dem Worker, und der sieht jede Nachricht im Klartext, bevor er sie
verpackt — er schreibt sie auch so in die Datenbank. Geschützt ist die Strecke
zu den Push-Diensten, nicht der Inhalt vor dem Betreiber des Space. Wer Zugriff
auf das Cloudflare-Konto hat, liest den gesamten Verlauf mit.

<br>

## API

Alles unter `/api/`, damit nichts mit Dateipfaden kollidiert. Alle Routen außer
`/api/config` verlangen `Authorization: Bearer <passwort>`.

| Route | Zweck |
|---|---|
| `GET /api/config` | VAPID Public Key — per Definition öffentlich |
| `POST /api/login` | Passwort prüfen |
| `POST /api/register` | `{name, device, subscription}` → Upsert auf `endpoint` |
| `POST /api/unregister` | dieses Gerät austragen |
| `GET /api/people` | Personen + Gerätezahl |
| `POST /api/send` | `{from, to, title, body, url}` |
| `GET /api/log` | Verlauf, `?me=…&with=…` |

<br>

## Datenmodell

Namen sind durchgehend **klein und einfach-leerzeichig**. Das ist keine Kosmetik:
dadurch ist der Anzeigename zugleich der Schlüssel, und es gibt keine zweite
Schreibweise, die auseinanderlaufen könnte. `  MAXIMILIAN   Kallina ` und
`maximilian kallina` sind dieselbe Person, ohne dass irgendwo entschieden werden muss,
welche Variante „gewinnt".

```sql
devices   person, device, endpoint UNIQUE, p256dh, auth, created_at
messages  sender, recipient, title, body, url, sent_at, delivered, total
```

`endpoint UNIQUE` macht die Re-Registrierung desselben Geräts zum Upsert statt
zum Duplikat. `recipient = '*'` ist der Broadcast und liest sich in der
Oberfläche wie ein Gruppenchat.

**D1 statt KV.** KV erlaubt nur einen Schreibvorgang pro Sekunde und Schlüssel
und ist eventually consistent — für einen gemeinsamen Verlauf zu fragil. D1
gibt geordnete Abfragen, ist stark konsistent und im Free Tier großzügiger.

<br>

## Auth

Das **Passwort ist selbst das Bearer-Token**, es gibt keine Session-Schicht.
Ein Session-Token wäre hier exakt so sicher wie das Passwort, das es ersetzt:
beides liegt im `localStorage`, beides gewährt dasselbe, keins ist einzeln
widerrufbar. Der Server hält nur einen SHA-256-Hash und vergleicht konstant-zeit.

**Kein Rate-Limiting, bewusst.** Das Passwort wird generiert, nicht gewählt —
24 Zeichen aus einem 32er-Alphabet, also 120 Bit. Durchprobieren ist damit kein
realistischer Angriff, und ein Zähler bräuchte zusätzlichen State für null
Gewinn. Aus demselben Grund kein PBKDF2: Key-Stretching schützt schwache
Passwörter, nicht zufällige.

Der Einladungslink trägt das Passwort im **Fragment** (`#k=…`). Fragmente
werden nie an den Server geschickt, landen also in keinem Log — wohl aber in
der Browser-History und in dem Chat, über den du den Link verschickt hast.

<br>

## Push

`worker/push.js` implementiert beide RFCs zu Fuß, in etwa 150 Zeilen:

| | |
|---|---|
| **RFC 8291** | ECDH P-256 → HKDF → AES-128-GCM, ein Record, `aes128gcm` |
| **RFC 8292** | ES256-JWT über `aud` + `exp` + `sub`, Header `vapid t=…, k=…` |

Kein `Buffer`, keine Node-Builtins — nur `crypto.subtle`, `fetch` und
`Uint8Array`. Dieselbe Datei läuft unverändert in Workers, Node, Deno und im
Browser, ohne Kompatibilitäts-Flags.

Eine Nachricht an eine Person fächert auf ihre Geräte auf. Antwortet ein Gerät
mit `410` oder `404`, ist die Subscription tot: das **Gerät** fliegt raus, die
Person bleibt.

**Die Notification zeigt auf iOS nur Titel und Text** — ein eigenes „von"-Feld
gibt es nicht. Ohne eigenen Titel steht deshalb der Absender dort:
„**maximilian kallina**" / „build ist durch". Wer geschrieben hat, steht im Verlauf
ohnehin immer.

<br>

## Plattformen

| | Empfangen | Anmerkung |
|---|---|---|
| **iPhone / iPad** | ab iOS 16.4 | nur vom Home-Bildschirm, siehe unten |
| **Android** | Chrome, Firefox, Edge | einfach im Tab, kein Installieren nötig |
| **Mac / Windows / Linux** | Chrome, Firefox, Edge, Safari | Desktop-Notifications |

Push läuft überall über dieselben RFCs — nur der Endpunkt unterscheidet sich
(Apple bei iOS und Safari, FCM bei Chrome und Android, Mozilla bei Firefox).
Der Code sieht davon nichts: er schickt an die URL, die in der Subscription
steht.

Senden kann ohnehin jeder Browser, ganz ohne Anmeldung — dafür braucht es nur
das Passwort.

<br>

## iOS

Der einzige Sonderfall. Push gibt es nur, wenn die Seite **vom Home-Bildschirm**
startet. In Safari selbst ist die API gesperrt — daran führt kein Weg vorbei.

Die App fängt das ab: läuft sie auf iOS und nicht im Standalone-Modus, zeigt
sie **ausschließlich** die Home-Bildschirm-Anleitung. Kein Passwortfeld, nichts,
woran man sich vorbeimogeln kann. Das ist Absicht — die PWA bekommt einen
eigenen Storage-Kontext, wer sich vorher in Safari anmeldet, müsste hinterher
alles nochmal eingeben.

<br>

## Eigene Domain

Danach wird beim Setup gefragt:

```
2  Adresse
   Eigene Domain? (z. B. pager.example.com — leer für workers.dev)
```

Leer lassen → der Space läuft unter `<name>.<subdomain>.workers.dev`. Gibst du
eine an, trägt `setup.mjs` sie als `custom_domain`-Route ein und schaltet
`workers.dev` ab, damit nur **eine** öffentliche Adresse existiert. Die Zone
muss in deinem Cloudflare-Konto liegen; den DNS-Eintrag und das Zertifikat legt
wrangler beim Deploy selbst an — rechne beim ersten Mal mit ein, zwei Minuten.

Gefragt wird außerdem nach einer **Kontaktadresse**. Die landet als
VAPID-Subject in jedem Push — darüber melden sich Apple und Google, wenn mit
deinen Nachrichten etwas nicht stimmt. Sie geht ausschließlich an die
Push-Dienste, nie an Nutzer deines Space. Vorgeschlagen wird die Adresse deines
Cloudflare-Kontos; du kannst jede andere eintragen.

Nicht-interaktiv geht beides auch:

```bash
node setup.mjs --domain=pager.example.com --email=pager@example.com
```

`wrangler.jsonc` trägt nach dem Setup deine eigenen Werte — Domain und
`database_id`. Das ist so gewollt: die Datei ist Konfiguration deiner Instanz,
kein Template. Ein Fork überschreibt sie beim ersten `npm run setup`.

<br>

## Betrieb

```bash
npm run deploy     # Codeänderungen ausrollen
npm run password   # neues Space-Passwort — Geräte bleiben angemeldet
npm run dev        # lokal auf localhost:8787
npm run logs       # live mitlesen
```

Für `npm run dev` brauchst du einmalig eine lokale Datenbank und lokale
Secrets — die echten liegen nur bei Cloudflare:

```bash
npx wrangler d1 execute pager --local --file worker/schema.sql
```

Dazu eine `.dev.vars` mit `PAGER_PASSWORD_HASH`, `VAPID_PUBLIC`,
`VAPID_PRIVATE` und `VAPID_SUBJECT` (gitignored). Die lokale D1 hängt an der
`database_id` aus `wrangler.jsonc` — ändert die sich, ist die lokale Datenbank
wieder leer.

`setup.mjs` gehört nur an den Anfang: ein zweiter Lauf erzeugt neue
VAPID-Schlüssel, und danach müssten sich alle Geräte neu anmelden. Zum
Aussperren einer Person reicht `npm run password` — das rotiert nur den
Passwort-Hash.

<br>

## Kosten

Nichts, in dieser Größenordnung.

Web Push auf iOS läuft ohne Apple-Developer-Account; die 99 €/Jahr fallen nur
für native Apps an. Cloudflares Free Tier deckt den Rest — 100.000
Worker-Requests am Tag, 5 GB D1. Eine Handvoll Leute kommt da nicht in die Nähe.

<br>

## Was es bewusst nicht ist

**Kein Messenger.** Kein Antwort-Button, keine Lesebestätigungen, keine
Verschachtelung. Man verfasst eine neue Nachricht an jemanden. Dass die
Historie dabei aussieht wie ein Chat, ist ein Nebeneffekt — der Punkt ist ein
Alarm, auf den man nicht antworten muss.

**Kein Rechtemodell.** Ein Passwort für den ganzen Space, keine Accounts, keine
Rollen. Der Absendername ist selbst gewählt und wird nicht geprüft: wer das
Passwort hat, kann sich nennen wie er will und jeden anfunken. Für eine
vertraute Runde gedacht, nicht für ein Unternehmen.

**Kein sicherer Messenger.** Der Verlauf liegt unverschlüsselt in D1, der
Betreiber kann alles mitlesen. Wer Vertraulichkeit vor dem Server braucht,
nimmt Signal — pager schickt Alarme, keine Geheimnisse.

**Ein Fork ist ein neuer Space, kein Beitritt.** Wer mitmachen soll, bekommt
einen Link — nicht das Repo.

<br>

---

<br>

<div align="center">

```
npm install  →  npm run setup
```

<sub>Cloudflare Workers · D1 · Web Push · null Laufzeit-Abhängigkeiten</sub>

<br><br>

<sub>MIT</sub>

</div>
