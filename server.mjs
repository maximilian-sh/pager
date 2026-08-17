// pager — lokaler Sender. Start: node server.mjs  →  http://localhost:8787
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sendPush } from './push.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Schlüsselpaar aus vapid.json — liegt nicht im Repo, erzeugt von keys.mjs.
// Der publicKey steht identisch in docs/index.html; ändert er sich,
// müssen sich alle Geräte neu anmelden.
const VAPID = { ttl: 60, ...JSON.parse(await readFile(join(here, 'vapid.json'), 'utf8')) };
const STORE = join(here, 'devices.json');
const PORT = 8787;

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

async function loadDevices() {
  try {
    return JSON.parse(await readFile(STORE, 'utf8'));
  } catch {
    return [];
  }
}

const saveDevices = (devices) => writeFile(STORE, JSON.stringify(devices, null, 2));

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
    const devices = await loadDevices();

    if (req.method === 'GET' && pathname === '/devices') {
      return json(res, 200, devices.map((d) => ({ name: d.name, endpoint: d.endpoint })));
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(join(here, 'sender.html')));
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw || '{}');

    if (pathname === '/devices/add') {
      const { name, subscription } = payload;
      let parsed;
      try {
        parsed = typeof subscription === 'string' ? JSON.parse(subscription) : subscription;
      } catch {
        return json(res, 400, { error: 'Kein gültiges JSON' });
      }
      if (!parsed?.endpoint || !parsed?.keys?.p256dh || !parsed?.keys?.auth) {
        return json(res, 400, { error: 'Es fehlt endpoint, keys.p256dh oder keys.auth' });
      }
      if (!name?.trim()) return json(res, 400, { error: 'Name fehlt' });
      if (devices.some((d) => d.name === name.trim())) {
        return json(res, 400, { error: `„${name.trim()}" gibt es schon` });
      }

      devices.push({ name: name.trim(), endpoint: parsed.endpoint, keys: parsed.keys });
      await saveDevices(devices);
      return json(res, 200, { added: name.trim() });
    }

    if (pathname === '/devices/remove') {
      await saveDevices(devices.filter((d) => d.name !== payload.name));
      return json(res, 200, { removed: payload.name });
    }

    if (pathname === '/send') {
      const { title, body, url, device } = payload;
      const targets = device && device !== 'all'
        ? devices.filter((d) => d.name === device)
        : devices;

      if (!targets.length) return json(res, 400, { error: 'Kein Gerät ausgewählt' });

      const message = JSON.stringify({ title, body, url });
      const results = await Promise.all(targets.map(async (target) => {
        try {
          const result = await sendPush(target, message, VAPID);
          return { name: target.name, ...result };
        } catch (err) {
          return { name: target.name, ok: false, error: err.message };
        }
      }));

      // 410/404 heißt: Subscription ist tot, Gerät kann raus.
      const dead = results.filter((r) => r.status === 410 || r.status === 404).map((r) => r.name);
      if (dead.length) await saveDevices(devices.filter((d) => !dead.includes(d.name)));

      return json(res, results.every((r) => r.ok) ? 200 : 502, { results, dead });
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`pager → http://localhost:${PORT}`));
