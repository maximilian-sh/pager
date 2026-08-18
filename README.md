<div align="center">

<img src=".github/hero.png" width="100%" alt="pager" />

<br>

**Short messages to your phone. No third party in between.**
One password, one link, and your iPhone buzzes.

<sub>Web Push · a PWA instead of an App Store listing · no Apple Developer account · zero dependencies</sub>

<br>

</div>

<div align="center">

**People, not devices**  ·  **Apple can't read it**  ·  **History as a thread**  ·  **one command to set up**

</div>

<br>

---

<br>

<div align="center">

A **space** is your own instance with one password.
Whoever is in it may send. Whoever registers can receive.

</div>

<br>

<table align="center" width="100%">
<tr>
<td width="50%" valign="top">

**📨 &nbsp; I was invited**

Tap the link · **Add to Home Screen** · open it from there · enter your name · allow notifications.

On a computer the link is enough. You can only send then, which is often all you need.

</td>
<td width="50%" valign="top">

**🔧 &nbsp; I'm opening a space**

```
npm install
npm run setup
```

Keys, password, database, deploy — one command, one browser login.

</td>
</tr>
</table>

<br>

---

<br>

<div align="center">

You address a **person**, not a device. A message to `maximilian kallina` reaches all of his devices —<br>
whether you send it from your Mac or your iPhone. That is why the history between two<br>
people is a thread by itself, without anyone building a chat.

</div>

<br>

---

<br>

# How it works

*What is built how, what runs where, and the reasoning behind it.*

<br>

## Architecture

A single Cloudflare Worker serves **both** the page and the API. No GitHub Pages
alongside it, no CORS, no second deploy that has to stay in sync. Static files
are served straight from `web/` and never reach the worker code — only paths
without a matching file, meaning `/api/*`, run through `worker/index.js`.

```
pager/
├─ worker/
│  ├─ index.js        router, auth, devices, sending, history
│  ├─ push.js         RFC 8291 (aes128gcm) + RFC 8292 (VAPID) — plain WebCrypto
│  └─ schema.sql      D1: devices, messages
├─ web/
│  ├─ index.html      the whole app: gate, login, identity, people, threads
│  ├─ sw.js           service worker — shows the notification, wakes open windows
│  └─ manifest.webmanifest
├─ setup.mjs          sets up a new space
├─ password.mjs       sets a new space password
├─ tools.mjs          shared pieces of both scripts
└─ wrangler.jsonc
```

Around 1500 lines in total, without a single runtime dependency. `wrangler` is
the only devDependency.

<br>

## How a message travels

```
Device registers   →  subscription lands in D1
                          ↓
You type text  →  worker encrypts  →  Apple  →  device
                                                  ↓
                                          sw.js shows it
```

Encryption happens in the worker, decryption only on the device. Apple and
Google merely relay and cannot read along — that is not a promise from us but
how Web Push is built.

**This is expressly not end-to-end encryption.** Encryption starts *at* the
worker, and the worker sees every message in plain text before it wraps it — it
also writes it to the database that way. What is protected is the leg to the
push services, not the content from the operator of the space. Anyone with
access to the Cloudflare account reads the entire history.

<br>

## API

Everything under `/api/`, so nothing collides with file paths. Every route
except `/api/config` requires `Authorization: Bearer <password>`.

| Route | Purpose |
|---|---|
| `GET /api/config` | VAPID public key — public by definition |
| `POST /api/login` | check the password |
| `POST /api/register` | `{name, device, subscription}` → upsert on `endpoint` |
| `POST /api/unregister` | remove this device |
| `GET /api/people` | people + device count |
| `POST /api/send` | `{from, to, title, body, url}` |
| `GET /api/log` | history, `?me=…&with=…` |

<br>

## Data model

Names are **lower case with single spaces** throughout. That is not cosmetic:
it makes the display name the key as well, so there is no second spelling that
could drift apart. `  MAXIMILIAN   Kallina ` and `maximilian kallina` are the
same person, without anything having to decide which variant "wins".

```sql
devices   person, device, endpoint UNIQUE, p256dh, auth, created_at
messages  sender, recipient, title, body, url, sent_at, delivered, total
```

`endpoint UNIQUE` turns re-registering the same device into an upsert instead
of a duplicate. `recipient = '*'` is the broadcast and reads like a group chat
in the interface.

**D1 instead of KV.** KV allows only one write per second per key and is
eventually consistent — too fragile for a shared history. D1 gives ordered
queries, is strongly consistent, and is more generous on the free tier.

<br>

## Auth

The **password is the bearer token** itself; there is no session layer. A
session token would be exactly as secure as the password it replaces: both sit
in `localStorage`, both grant the same thing, neither can be revoked
individually. The server keeps only a SHA-256 hash and compares in constant
time.

**No rate limiting, deliberately.** The password is generated, not chosen — 24
characters from a 32-character alphabet, so 120 bits. Guessing is not a
realistic attack, and a counter would need extra state for no gain. Same reason
there is no PBKDF2: key stretching protects weak passwords, not random ones.

The invite link carries the password in the **fragment** (`#k=…`). Fragments are
never sent to the server, so they appear in no log — but they do appear in
browser history and in the chat you sent the link through.

Because of that, and because an installed iOS app starts without the fragment
and with its own storage, the Home Screen gate shows the password once with a
copy button. Only when it actually came from the link — never when it merely
sits in `localStorage`.

<br>

## Push

`worker/push.js` implements both RFCs by hand, in about 150 lines:

| | |
|---|---|
| **RFC 8291** | ECDH P-256 → HKDF → AES-128-GCM, one record, `aes128gcm` |
| **RFC 8292** | ES256 JWT over `aud` + `exp` + `sub`, header `vapid t=…, k=…` |

No `Buffer`, no Node builtins — only `crypto.subtle`, `fetch` and `Uint8Array`.
The same file runs unchanged in Workers, Node, Deno and the browser, without
compatibility flags.

A message to a person fans out to their devices. If a device answers `410` or
`404` the subscription is dead: the **device** is dropped, the person stays.

**A notification on iOS shows only a title and body** — there is no separate
"from" field. Without a title of your own the sender goes there:
"**maximilian kallina**" / "build is green". Who wrote it is in the history
regardless.

<br>

## Platforms

| | Receiving | Note |
|---|---|---|
| **iPhone / iPad** | iOS 16.4+ | Home Screen only, see below |
| **Android** | Chrome, Firefox, Edge | plain browser tab, no install needed |
| **Mac / Windows / Linux** | Chrome, Firefox, Edge, Safari | desktop notifications |

Push runs over the same RFCs everywhere — only the endpoint differs (Apple for
iOS and Safari, FCM for Chrome and Android, Mozilla for Firefox). The code sees
none of it: it posts to whatever URL the subscription carries.

Sending works from any browser without registering at all — that only needs the
password.

<br>

## iOS

The one special case. Push exists only when the page is launched **from the
Home Screen**. In Safari itself the API is locked, and there is no way around
that.

The app catches it: running on iOS and not in standalone mode, it shows
**nothing but** the Home Screen instructions. No password field, nothing to slip
past. That is on purpose — the installed app gets its own storage context, so
anyone signing in beforehand in Safari would have to enter everything again.

<br>

## Custom domain

You are asked during setup:

```
2  Address and contact
   Custom domain? (e.g. pager.example.com — blank for workers.dev)
```

Leave it blank and the space runs on `<name>.<subdomain>.workers.dev`. Give one
and `setup.mjs` writes it as a `custom_domain` route and turns `workers.dev`
off, so exactly **one** public address exists. The zone has to live in your
Cloudflare account; wrangler creates the DNS record and the certificate on
deploy — expect a minute or two the first time.

You are also asked for a **contact address**. It goes into every push as the
VAPID subject — Apple and Google use it to reach you when something is wrong
with your messages. It goes to the push services only, never to users of your
space. Your Cloudflare account address is suggested; any other works.

Both work non-interactively too:

```bash
node setup.mjs --domain=pager.example.com --email=pager@example.com
```

After setup `wrangler.jsonc` carries your own values — domain and
`database_id`. That is intended: the file is configuration of your instance,
not a template. A fork overwrites it on its first `npm run setup`.

<br>

## Operating

```bash
npm run deploy     # roll out code changes
npm run password   # new space password — devices stay registered
npm run dev        # local, on localhost:8787
npm run logs       # follow live
```

`setup.mjs` belongs at the beginning only: a second run generates new VAPID
keys, and every device would have to register again. To lock someone out,
`npm run password` is enough — it rotates the password hash and nothing else.

For `npm run dev` you need a local database and local secrets once; the real
ones live at Cloudflare only:

```bash
npx wrangler d1 execute pager --local --file worker/schema.sql
```

Plus a `.dev.vars` with `PAGER_PASSWORD_HASH`, `VAPID_PUBLIC`, `VAPID_PRIVATE`
and `VAPID_SUBJECT` (gitignored). The local D1 hangs off the `database_id` in
`wrangler.jsonc` — change that and the local database is empty again.

<br>

## Cost

Nothing, at this scale.

Web Push on iOS runs without an Apple Developer account; the 99 €/year applies
to native apps only. Cloudflare's free tier covers the rest — 100,000 worker
requests a day, 5 GB of D1. A handful of people will not come close.

<br>

## What it deliberately is not

**Not a messenger.** No reply button, no read receipts, no nesting. You compose
a new message to someone. That the history ends up looking like a chat is a side
effect — the point is an alert nobody has to answer.

**Not a permission model.** One password for the whole space, no accounts, no
roles. The sender name is self-chosen and unverified: whoever has the password
can call themselves anything and page anyone. Meant for a circle that trusts
each other, not for a company.

**Not a secure messenger.** The history sits unencrypted in D1 and the operator
can read all of it. If you need confidentiality from the server, use Signal —
pager sends alerts, not secrets.

**A fork is a new space, not a way to join one.** Whoever should take part gets
a link, not the repo.

<br>

---

<br>

<div align="center">

```
npm install  →  npm run setup
```

<sub>Cloudflare Workers · D1 · Web Push · zero runtime dependencies</sub>

<br><br>

<sub>The interface is in English; code comments are in German.</sub>

<br>

<sub>MIT</sub>

</div>
