// pager — ein Space. Wer das Passwort hat, darf senden; wer sich anmeldet,
// kann empfangen. Adressiert wird die Person, nicht das Gerät.
//
// Statische Dateien liefert Cloudflare direkt aus web/ aus (siehe
// wrangler.jsonc). Hier landen nur Pfade, für die es keine Datei gibt.

import { sendPush } from './push.js';

const MAX_BODY = 1000;
const LOG_LIMIT = 200;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// Namen sind klein und einfach-leerzeichig. Das ist zugleich der Schlüssel und
// der Anzeigename — "  MAXIMILIAN   Kallina " und "maximilian kallina" sind dieselbe Person.
// Nicht auf Nachrichten anwenden, dort sind Zeilenumbrüche gewollt.
const name = (value) => clean(value).replace(/\s+/g, ' ').toLowerCase();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Konstant-zeit, damit die Antwortdauer nichts über den Hash verrät.
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Das Passwort ist selbst das Bearer-Token. Eine Session-Schicht wäre hier
// genauso sicher wie das Passwort, das sie ersetzt — beides liegt im
// localStorage und lässt sich nicht einzeln widerrufen.
async function authorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  return equal(await sha256Hex(header.slice(7)), env.PAGER_PASSWORD_HASH);
}

// ─── Geräte ──────────────────────────────────────────────────────────────────

async function register(request, env) {
  const { name: input, device, subscription } = await request.json();

  const person = name(input);
  if (!person) return json({ error: 'Name fehlt' }, 400);
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ error: 'Es fehlt endpoint, keys.p256dh oder keys.auth' }, 400);
  }

  // Dasselbe Gerät meldet sich neu an → aktualisieren statt verdoppeln.
  await env.DB.prepare(`
    INSERT INTO devices (person, device, endpoint, p256dh, auth, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(endpoint) DO UPDATE SET
      person = ?1, device = ?2, p256dh = ?4, auth = ?5
  `).bind(
    person, name(device) || 'gerät',
    subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
    Date.now(),
  ).run();

  return json({ person });
}

async function unregister(request, env) {
  const { endpoint } = await request.json();
  if (!endpoint) return json({ error: 'endpoint fehlt' }, 400);
  await env.DB.prepare('DELETE FROM devices WHERE endpoint = ?').bind(endpoint).run();
  return json({ ok: true });
}

async function people(env) {
  const { results } = await env.DB.prepare(`
    SELECT person, COUNT(*) AS devices
    FROM devices
    GROUP BY person
    ORDER BY person
  `).all();
  return json(results);
}

// ─── Senden ──────────────────────────────────────────────────────────────────

async function send(request, env) {
  const payload = await request.json();

  const from = name(payload.from);
  const to = payload.to === '*' ? '*' : name(payload.to);
  const title = clean(payload.title);
  const body = clean(payload.body);
  const url = clean(payload.url);

  if (!from) return json({ error: 'Absender fehlt' }, 400);
  if (!to) return json({ error: 'Empfänger fehlt' }, 400);
  if (!body) return json({ error: 'Nachricht ist leer' }, 400);
  if (body.length > MAX_BODY) {
    return json({ error: `Nachricht ist zu lang (max. ${MAX_BODY} Zeichen)` }, 400);
  }

  const { results: devices } = to === '*'
    ? await env.DB.prepare('SELECT * FROM devices').all()
    : await env.DB.prepare('SELECT * FROM devices WHERE person = ?').bind(to).all();

  if (!devices.length) return json({ error: 'Keine angemeldeten Geräte für diesen Empfänger' }, 400);

  // Eine Notification zeigt auf iOS nur Titel und Text — ein eigenes
  // „von"-Feld gibt es nicht. Ohne eigenen Titel steht deshalb der Absender
  // dort, damit man auf einen Blick sieht, wer paged.
  const message = JSON.stringify({
    title: title || from,
    body,
    url: url || undefined,
  });

  const vapid = {
    publicKey: env.VAPID_PUBLIC,
    privateKey: env.VAPID_PRIVATE,
    subject: env.VAPID_SUBJECT,
    ttl: 60,
  };

  const results = await Promise.all(devices.map(async (device) => {
    try {
      const result = await sendPush(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        message,
        vapid,
      );
      return { id: device.id, device: device.device, ...result };
    } catch (err) {
      return { id: device.id, device: device.device, ok: false, error: err.message };
    }
  }));

  // 410/404 heißt: Subscription ist tot. Das Gerät fliegt raus, die Person bleibt.
  const dead = results.filter((r) => r.status === 410 || r.status === 404).map((r) => r.id);
  if (dead.length) {
    await env.DB.prepare(
      `DELETE FROM devices WHERE id IN (${dead.map(() => '?').join(',')})`,
    ).bind(...dead).run();
  }

  const delivered = results.filter((r) => r.ok).length;

  await env.DB.prepare(`
    INSERT INTO messages (sender, recipient, title, body, url, sent_at, delivered, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    from, to, title || null, body, url || null,
    Date.now(), delivered, results.length,
  ).run();

  return json({
    delivered,
    total: results.length,
    dead: dead.length,
    results: results.map((r) => ({ device: r.device, ok: r.ok, status: r.status, error: r.error })),
  }, delivered ? 200 : 502);
}

// ─── Verlauf ─────────────────────────────────────────────────────────────────

async function log(url, env) {
  const me = name(url.searchParams.get('me') || '');
  const withPerson = url.searchParams.get('with');

  // Ein Thread ist ein Paar von Personen, egal von welchem Gerät gesendet wurde.
  if (withPerson === '*') {
    const { results } = await env.DB.prepare(`
      SELECT * FROM messages WHERE recipient = '*' ORDER BY sent_at DESC LIMIT ?
    `).bind(LOG_LIMIT).all();
    return json(results.reverse());
  }

  if (withPerson) {
    const other = name(withPerson);
    const { results } = await env.DB.prepare(`
      SELECT * FROM messages
      WHERE (sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1)
      ORDER BY sent_at DESC LIMIT ?3
    `).bind(me, other, LOG_LIMIT).all();
    return json(results.reverse());
  }

  const { results } = await env.DB.prepare(
    'SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?',
  ).bind(LOG_LIMIT).all();
  return json(results.reverse());
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }

    // Der VAPID Public Key ist per Definition öffentlich — die Seite braucht
    // ihn, um sich überhaupt anmelden zu können.
    if (route === 'GET /api/config') {
      return json({ vapidPublic: env.VAPID_PUBLIC });
    }

    if (!await authorized(request, env)) {
      return json({ error: 'Falsches Passwort' }, 401);
    }

    try {
      switch (route) {
        case 'POST /api/login':      return json({ ok: true });
        case 'POST /api/register':   return await register(request, env);
        case 'POST /api/unregister': return await unregister(request, env);
        case 'GET /api/people':      return await people(env);
        case 'POST /api/send':       return await send(request, env);
        case 'GET /api/log':         return await log(url, env);
        default:                     return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
