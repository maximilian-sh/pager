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
  console.log('\n\x1b[1mpager\x1b[0m — neuen Space einrichten');

  // ─── 1. Cloudflare ─────────────────────────────────────────────────────────
  step(1, 'Cloudflare-Konto');
  let who = await wrangler(['whoami'], { allowFail: true });
  if (/You are not authenticated|not logged in/i.test(who)) {
    info('Nicht angemeldet — der Browser öffnet sich gleich.');
    await wrangler(['login'], { interactive: true });
    who = await wrangler(['whoami'], { allowFail: true });
  }

  const accountEmail = who.match(/associated with the email (\S+@\S+)/)?.[1]?.replace(/\.$/, '');
  info(accountEmail ?? 'angemeldet');

  // ─── 2. Adresse und Kontakt ────────────────────────────────────────────────
  // Beides zuerst fragen, bevor irgendetwas angelegt wird: eine falsche Eingabe
  // soll abbrechen, solange noch nichts passiert und kein Passwort rotiert ist.
  step(2, 'Adresse und Kontakt');
  const domain = await askDomain();
  const subject = await askSubject(accountEmail);
  info(domain
    ? `${domain} — den DNS-Eintrag legt wrangler beim Deploy an.`
    : 'workers.dev — eine eigene Domain kannst du später in wrangler.jsonc nachtragen.');

  // ─── 3. Schlüssel und Passwort ─────────────────────────────────────────────
  step(3, 'Schlüsselpaar und Passwort erzeugen');
  const keys = await generateVapidKeys();
  const password = generatePassword();

  // Sofort ausgeben, nicht erst am Ende: gespeichert wird nur der Hash, und
  // wenn ein späterer Schritt abbricht, wäre das Passwort sonst unrettbar weg.
  box('Passwort', password);
  info('Jetzt sichern. Es steht nirgends sonst im Klartext.');

  // ─── 4. Datenbank ──────────────────────────────────────────────────────────
  step(4, 'Datenbank');
  const list = JSON.parse(await wrangler(['d1', 'list', '--json'], { allowFail: true }) || '[]');
  let database = list.find?.((d) => d.name === 'pager');

  if (database) {
    info(`„pager" gibt es schon (${database.uuid}) — wird weiterverwendet.`);
  } else {
    await wrangler(['d1', 'create', 'pager']);
    const created = JSON.parse(await wrangler(['d1', 'list', '--json']));
    database = created.find((d) => d.name === 'pager');
    if (!database) throw new Error('Datenbank angelegt, aber nicht wiedergefunden.');
    info(`angelegt (${database.uuid})`);
  }

  await writeConfig(CONFIG, { databaseId: database.uuid, domain });

  step(5, 'Tabellen anlegen');
  await wrangler(['d1', 'execute', 'pager', '--remote', '--yes', '--file', SCHEMA]);
  info('devices und messages stehen.');

  // ─── 6. Secrets ────────────────────────────────────────────────────────────
  step(6, 'Secrets setzen');
  await putSecrets({
    PAGER_PASSWORD_HASH: await sha256Hex(password),
    VAPID_PUBLIC: keys.publicKey,
    VAPID_PRIVATE: keys.privateKey,
    VAPID_SUBJECT: `mailto:${subject}`,
  });
  info('Nur der Hash des Passworts liegt auf dem Server.');

  // ─── 7. Deploy ─────────────────────────────────────────────────────────────
  step(7, 'Deployen');

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
\x1b[1mFast fertig — ein einmaliger Schritt fehlt.\x1b[0m

Dein Konto hat noch keine workers.dev-Subdomain. Im Dashboard unter
\x1b[1mWorkers & Pages\x1b[0m neben „Your subdomain" auf \x1b[1mChange\x1b[0m
(Name frei wählbar, gilt fürs ganze Konto):

  https://dash.cloudflare.com/${account ?? ''}/workers-and-pages

Danach:

  npm run deploy

Alles andere steht schon: Datenbank, Tabellen, Secrets, Worker-Code.
\x1b[1mDas Passwort von oben bleibt gültig\x1b[0m — starte setup.mjs nicht neu,
das würde Schlüssel und Passwort neu erzeugen.
`);
    return;
  }

  const url = await spaceUrl(CONFIG, deployed);
  if (!url) {
    console.log(deployed);
    throw new Error('Deploy lief, aber die Adresse war nicht zu ermitteln.');
  }

  // ─── Fertig ────────────────────────────────────────────────────────────────
  console.log(`
\x1b[1mFertig.\x1b[0m

  Space      ${url}
  Passwort   ${password}

\x1b[1mEinladungslink\x1b[0m — Passwort ist schon drin:

  ${url}/#k=${password}

Auf dem iPhone: Link öffnen, zum Home-Bildschirm hinzufügen, von dort starten.
In Safari selbst gibt iOS kein Push frei.

\x1b[2msetup.mjs erneut auszuführen erzeugt neue Schlüssel und ein neues Passwort —
alle angemeldeten Geräte müssen sich danach neu anmelden. Für ein reines
Code-Update genügt npm run deploy.\x1b[0m
`);
}

main().catch((err) => {
  console.error(`\n\x1b[31m${err.message}\x1b[0m\n`);
  process.exit(1);
});
