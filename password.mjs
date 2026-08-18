// Neues Space-Passwort setzen: node password.mjs
//
// Erzeugt ein frisches Passwort und ersetzt den Hash im Worker. Schlüssel und
// angemeldete Geräte bleiben unangetastet — nur wer den alten Einladungslink
// hat, kommt danach nicht mehr rein.

import { wrangler, box, info, generatePassword, sha256Hex, putSecrets, spaceUrl } from './tools.mjs';

const password = generatePassword();

console.log('\n\x1b[1mpager\x1b[0m — new password');
box('Password', password);
info('Save it now. Only the hash is stored.');

await putSecrets({ PAGER_PASSWORD_HASH: await sha256Hex(password) });

// Für den Einladungslink brauchen wir die Adresse. Bei eigener Domain steht
// sie in der Config, sonst muss sie aus einer Deploy-Ausgabe kommen.
const CONFIG = new URL('./wrangler.jsonc', import.meta.url);
const url = await spaceUrl(CONFIG, await wrangler(['deploy', '--dry-run'], { allowFail: true }));

console.log(`
\x1b[1mDone.\x1b[0m The old password stops working immediately.

New invite link:

  ${url ? `${url}/#k=${password}` : `<your-worker-url>/#k=${password}`}

\x1b[2mRegistered devices keep receiving — the password only opens the app. Anyone
already signed in is locked out on next launch and needs the new link.\x1b[0m
`);
