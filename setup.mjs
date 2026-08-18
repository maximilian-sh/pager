// Einmalig laufen lassen: node setup.mjs
//
// Legt einen neuen Space an: Schlüsselpaar, Passwort, Datenbank, Deploy.
// Am Ende steht ein Link, den du weitergeben kannst.

import { generateVapidKeys } from './worker/push.js';
import {
  wrangler, step, info, box, writeConfig, askDomain, askSubject,
  generatePassword, sha256Hex, putSecrets, spaceUrl,
} from './tools.mjs';

const CONFIG = new URL('./wrangler.jsonc', import.meta.url);
const SCHEMA = 'worker/schema.sql';

async function main() {
  console.log('\n\x1b[1mpager\x1b[0m — set up a new space');

  // ─── 1. Cloudflare ─────────────────────────────────────────────────────────
  step(1, 'Cloudflare account');
  let who = await wrangler(['whoami'], { allowFail: true });
  if (/You are not authenticated|not logged in/i.test(who)) {
    info('Not signed in — your browser will open in a moment.');
    await wrangler(['login'], { interactive: true });
    who = await wrangler(['whoami'], { allowFail: true });
  }

  const accountEmail = who.match(/associated with the email (\S+@\S+)/)?.[1]?.replace(/\.$/, '');
  info(accountEmail ?? 'signed in');

  // ─── 2. Adresse und Kontakt ────────────────────────────────────────────────
  // Beides zuerst fragen, bevor irgendetwas angelegt wird: eine falsche Eingabe
  // soll abbrechen, solange noch nichts passiert und kein Passwort rotiert ist.
  step(2, 'Address and contact');
  const domain = await askDomain();
  const subject = await askSubject(accountEmail);
  info(domain
    ? `${domain} — wrangler creates the DNS record on deploy.`
    : 'workers.dev — you can add a custom domain to wrangler.jsonc later.');

  // ─── 3. Schlüssel und Passwort ─────────────────────────────────────────────
  step(3, 'Generate key pair and password');
  const keys = await generateVapidKeys();
  const password = generatePassword();

  // Sofort ausgeben, nicht erst am Ende: gespeichert wird nur der Hash, und
  // wenn ein späterer Schritt abbricht, wäre das Passwort sonst unrettbar weg.
  box('Password', password);
  info('Save it now. It exists in plain text nowhere else.');

  // ─── 4. Datenbank ──────────────────────────────────────────────────────────
  step(4, 'Database');
  const list = JSON.parse(await wrangler(['d1', 'list', '--json'], { allowFail: true }) || '[]');
  let database = list.find?.((d) => d.name === 'pager');

  if (database) {
    info(`"pager" already exists (${database.uuid}) — reusing it.`);
  } else {
    await wrangler(['d1', 'create', 'pager']);
    const created = JSON.parse(await wrangler(['d1', 'list', '--json']));
    database = created.find((d) => d.name === 'pager');
    if (!database) throw new Error('Database created but not found afterwards.');
    info(`created (${database.uuid})`);
  }

  await writeConfig(CONFIG, { databaseId: database.uuid, domain });

  step(5, 'Create tables');
  await wrangler(['d1', 'execute', 'pager', '--remote', '--yes', '--file', SCHEMA]);
  info('devices and messages are in place.');

  // ─── 6. Secrets ────────────────────────────────────────────────────────────
  step(6, 'Set secrets');
  await putSecrets({
    PAGER_PASSWORD_HASH: await sha256Hex(password),
    VAPID_PUBLIC: keys.publicKey,
    VAPID_PRIVATE: keys.privateKey,
    VAPID_SUBJECT: `mailto:${subject}`,
  });
  info('Only the hash of the password lives on the server.');

  // ─── 7. Deploy ─────────────────────────────────────────────────────────────
  step(7, 'Deploy');

  // Voll durchgereicht, nicht mitgeschnitten: wrangler entscheidet an *stdout*,
  // ob es interaktiv ist. Sobald wir die Ausgabe umleiten, überspringt es die
  // Rückfrage nach der workers.dev-Subdomain und beantwortet sie mit „nein".
  await wrangler(['deploy'], { interactive: true, allowFail: true });

  // Die URL stand nur in der eben durchgereichten Ausgabe, also einmal
  // nachfassen. Ohne geänderte Assets ist der zweite Lauf billig — und falls
  // oben „nein" gewählt wurde, scheitert er identisch und wir fangen es unten.
  const deployed = await wrangler(['deploy'], { allowFail: true });

  // Ein frisches Konto hat noch keine workers.dev-Subdomain. Anlegen geht nur
  // im Dashboard — es gibt dafür weder einen wrangler-Befehl noch eine API.
  // Wrangler fragt zwar beim Deploy nach, aber nur an einem echten Terminal.
  if (/register a workers\.dev subdomain/i.test(deployed)) {
    // Die von wrangler ausgegebene /workers/onboarding-URL ist tot; der
    // aktuelle Pfad ist /workers-and-pages.
    const account = deployed.match(/dash\.cloudflare\.com\/([0-9a-f]{32})/)?.[1];
    console.log(`
\x1b[1mAlmost there — one one-time step is missing.\x1b[0m

Your account has no workers.dev subdomain yet. In the dashboard under
\x1b[1mWorkers & Pages\x1b[0m, next to "Your subdomain", hit \x1b[1mChange\x1b[0m
(any name, applies to the whole account):

  https://dash.cloudflare.com/${account ?? ''}/workers-and-pages

Then:

  npm run deploy

Everything else is already in place: database, tables, secrets, worker code.
\x1b[1mThe password above stays valid\x1b[0m — do not re-run setup.mjs, that
would generate new keys and a new password.
`);
    return;
  }

  const url = await spaceUrl(CONFIG, deployed);
  if (!url) {
    console.log(deployed);
    throw new Error('Deploy succeeded but the address could not be determined.');
  }

  // ─── Fertig ────────────────────────────────────────────────────────────────
  console.log(`
\x1b[1mDone.\x1b[0m

  Space      ${url}
  Password   ${password}

\x1b[1mInvite link\x1b[0m — password already included:

  ${url}/#k=${password}

On iPhone: open the link, add to Home Screen, launch it from there.
Safari itself gets no push from iOS.

\x1b[2mRunning setup.mjs again generates new keys and a new password — every
registered device would have to register again. For a plain code update
npm run deploy is enough.\x1b[0m
`);
}

main().catch((err) => {
  console.error(`\n\x1b[31m${err.message}\x1b[0m\n`);
  process.exit(1);
});
