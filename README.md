# pager

Kurze Nachrichten aufs Handy schicken. Web Push, ohne fremden Dienst dazwischen.

## Die zwei Hälften

Das Projekt besteht aus zwei Teilen, die verschiedenen Leuten gehören und an
verschiedenen Orten laufen:

| | **Empfangen** (`docs/`) | **Senden** (`server.mjs`) |
|---|---|---|
| Wer | jeder, der Nachrichten kriegen will | nur du |
| Läuft wo | öffentlich im Netz, HTTPS | dein Mac, `localhost:8787` |
| Was es tut | Handy anmelden, Notifications anzeigen | Nachricht verschlüsseln und abschicken |
| Kennt | den **öffentlichen** Schlüssel | den **privaten** Schlüssel |

Beide Hälften kennen sich nicht direkt. Verbunden werden sie über einen
Textblock, die **Subscription** — die entsteht auf dem Handy und wandert per
Copy-Paste in die Sende-Seite.

## Wie eine Nachricht läuft

```
Handy meldet sich an  →  Subscription (endpoint + 2 Schlüssel)
                             ↓  Copy-Paste
Du tippst Text  →  server.mjs verschlüsselt  →  Apple  →  Handy
                                                            ↓
                                                    sw.js zeigt sie an
```

Der Text wird auf deinem Mac verschlüsselt und erst auf dem Handy wieder
entschlüsselt. Apple leitet nur weiter und kann nicht mitlesen.

## Ja, mehrere Leute geht

Genau dafür ist es gebaut. Jeder öffnet deine `docs/`-Seite, meldet sich an,
schickt dir sein JSON, du fügst es unter **Geräte** ein — fertig. Im Dropdown
wählst du dann einzelne Personen oder **Alle Geräte**.

Zwei Sachen, die dabei wichtig sind:

- **Senden kannst nur du.** Der Sender läuft auf deinem Rechner und hat als
  einziger den privaten Schlüssel. Die anderen können sich nur anmelden.
- **Alle müssen über dieselbe Seite anmelden.** Die Subscription ist an den
  öffentlichen Schlüssel gebunden, der in `docs/index.html` steht. Eine andere
  Seite mit anderem Schlüssel funktioniert nicht.

## Einrichten

```bash
node keys.mjs      # einmalig: erzeugt vapid.json + trägt den Public Key ein
node server.mjs    # → http://localhost:8787
```

Dann `docs/` auf irgendeinen HTTPS-Host legen, z. B.:

```bash
npx wrangler pages deploy docs --project-name pager
```

**HTTPS ist Pflicht** — ohne läuft kein Service Worker, also kein Push.
Auf dem iPhone muss die Seite außerdem **zum Home-Bildschirm hinzugefügt**
und von dort gestartet werden; in Safari selbst gibt iOS kein Push frei.

## Dateien

```
docs/index.html   Anmelde-Seite fürs Handy
docs/sw.js        Service Worker — zeigt die Notification an
sender.html       Sende-Oberfläche
server.mjs        Backend: Geräte verwalten, senden
push.mjs          Verschlüsselung (RFC 8291) + VAPID (RFC 8292), ohne Dependencies
keys.mjs          erzeugt das Schlüsselpaar
```

`vapid.json` (privater Schlüssel) und `devices.json` (angemeldete Geräte)
bleiben lokal und sind in `.gitignore`.

## Wenn etwas nicht geht

| Meldung | Grund |
|---|---|
| `403` | Schlüssel passt nicht zur Anmeldung — neu anmelden |
| `410` / `404` | Gerät hat sich abgemeldet; pager wirft es automatisch raus |
| Kein Push auf iOS | Seite läuft in Safari statt vom Home-Bildschirm |
| Notification ohne Text | `sw.js` bekommt kein JSON — Payload prüfen |
