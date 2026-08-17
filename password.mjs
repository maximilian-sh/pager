// Neues Space-Passwort setzen: node password.mjs
//
// Erzeugt ein frisches Passwort und ersetzt den Hash im Worker. Schlüssel und
// angemeldete Geräte bleiben unangetastet — nur wer den alten Einladungslink
// hat, kommt danach nicht mehr rein.

import { wrangler, box, info, generatePassword, sha256Hex, putSecrets, spaceUrl } from './tools.mjs';

const password = generatePassword();

console.log('\n\x1b[1mpager\x1b[0m — neues Passwort');
box('Passwort', password);
info('Jetzt sichern. Gespeichert wird nur der Hash.');

await putSecrets({ PAGER_PASSWORD_HASH: await sha256Hex(password) });

// Für den Einladungslink brauchen wir die Adresse. Bei eigener Domain steht
// sie in der Config, sonst muss sie aus einer Deploy-Ausgabe kommen.
const CONFIG = new URL('./wrangler.jsonc', import.meta.url);
const url = await spaceUrl(CONFIG, await wrangler(['deploy', '--dry-run'], { allowFail: true }));

console.log(`
\x1b[1mGesetzt.\x1b[0m Das alte Passwort gilt ab sofort nicht mehr.

Neuer Einladungslink:

  ${url ? `${url}/#k=${password}` : `<deine-worker-url>/#k=${password}`}

\x1b[2mAngemeldete Geräte empfangen weiter — sie brauchen das Passwort nur, um die
App zu öffnen. Wer bereits eingeloggt ist, wird beim nächsten Start ausgesperrt
und muss den neuen Link antippen.\x1b[0m
`);
