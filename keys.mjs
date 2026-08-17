// Einmalig laufen lassen: node keys.mjs
// Erzeugt vapid.json (bleibt lokal) und trägt den öffentlichen Teil in docs/index.html ein.
import { readFile, writeFile } from 'node:fs/promises';
import { generateVapidKeys } from './push.mjs';

const keys = await generateVapidKeys();

await writeFile('vapid.json', JSON.stringify({
  ...keys,
  subject: 'mailto:du@example.com',
}, null, 2));

const page = await readFile('docs/index.html', 'utf8');
await writeFile('docs/index.html', page.replace(
  /const VAPID_PUBLIC = '[^']*'/,
  `const VAPID_PUBLIC = '${keys.publicKey}'`,
));

console.log('vapid.json geschrieben, docs/index.html aktualisiert.');
console.log('Public Key:', keys.publicKey);
console.log('\nAchtung: alle Geräte müssen sich danach neu anmelden.');
