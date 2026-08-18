// Gemeinsame Bausteine für setup.mjs und password.mjs.

import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

const SECRETS_FILE = '.pager-secrets.json';

export const step = (n, text) => console.log(`\n\x1b[1m${n}\x1b[0m  ${text}`);
export const info = (text) => console.log(`   \x1b[2m${text}\x1b[0m`);

/** Rahmen wird aus dem Inhalt berechnet, damit er nie verrutscht. */
export function box(label, value) {
  const inner = `  ${label}   ${value}  `;
  const edge = '─'.repeat(inner.length);
  console.log(`\n   ┌${edge}┐\n   │\x1b[1m${inner}\x1b[0m│\n   └${edge}┘`);
}

/**
 * Wrangler ausführen.
 *
 * `interactive` reicht stdio komplett durch (Login).
 * `tee` gibt die Ausgabe live aus **und** sammelt sie — nötig überall dort, wo
 * wrangler eine Rückfrage stellt: bei umgeleitetem stdout hält es sich für
 * nicht-interaktiv und beantwortet die Frage still mit „nein".
 */
export function wrangler(args, { interactive = false, tee = false, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', ...args], {
      stdio: interactive ? 'inherit' : [tee ? 'inherit' : 'ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk; if (tee) process.stdout.write(chunk); });
    child.stderr?.on('data', (chunk) => { out += chunk; if (tee) process.stderr.write(chunk); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFail) return resolve(out);
      reject(new Error(`wrangler ${args.join(' ')} failed:\n${out}`));
    });
  });
}

/** 24 Zeichen aus einem 32er-Alphabet = 120 Bit. Kein Modulo-Bias, 32 teilt 256. */
export function generatePassword() {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map((byte) => alphabet[byte & 31])
    .join('');
}

export const sha256Hex = async (text) => [...new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Secrets über eine Datei setzen, nicht als Argument — Kommandozeilen landen
 * in der Shell-History und in Prozesslisten.
 */
export async function putSecrets(values) {
  try {
    await writeFile(SECRETS_FILE, JSON.stringify(values), { mode: 0o600 });
    await wrangler(['secret', 'bulk', SECRETS_FILE]);
  } finally {
    await unlink(SECRETS_FILE).catch(() => {});
  }
}

/** Die workers.dev-URL aus einer wrangler-deploy-Ausgabe fischen. */
export const deployedUrl = (output) => output.match(/https:\/\/[^\s]*workers\.dev/)?.[0];

/**
 * Die Adresse des Space. Eine eingetragene Custom Domain gewinnt — sie taucht
 * in der Deploy-Ausgabe nämlich gar nicht auf, weshalb deployedUrl() dort ins
 * Leere greifen würde.
 */
export async function spaceUrl(configPath, deployOutput = '') {
  const config = await readFile(configPath, 'utf8');
  const routes = config.match(/"routes":\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const domain = routes.match(/"pattern":\s*"([^"]+)"/)?.[1];
  return domain ? `https://${domain}` : deployedUrl(deployOutput);
}

/**
 * Eine Frage stellen. Ohne Terminal — CI, Pipe, Aufruf aus einem Skript —
 * gibt es kommentarlos die Vorgabe zurück, statt ewig zu blockieren.
 */
export async function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Grobe Plausibilität für einen Hostnamen wie pager.example.com. */
export const looksLikeHostname = (value) =>
  /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);

/**
 * database_id, Route und workers_dev in wrangler.jsonc eintragen.
 *
 * Bewusst Textersatz statt JSON-Parsen: die Datei ist JSONC und lebt von ihren
 * Kommentaren — einmal durch JSON.parse und zurück wären sie weg.
 */
export async function writeConfig(configPath, { databaseId, domain }) {
  let config = await readFile(configPath, 'utf8');

  config = config.replace(/("database_id":\s*)"[^"]*"/, `$1"${databaseId}"`);
  if (!config.includes(databaseId)) {
    throw new Error('Could not write database_id into wrangler.jsonc.');
  }

  // Eine eigene Domain schaltet workers.dev ab — sonst hinge der Space an zwei
  // öffentlichen Adressen, von denen niemand die zweite haben will.
  config = config
    .replace(/("routes":\s*)\[[\s\S]*?\]/, domain
      ? `$1[\n    { "pattern": "${domain}", "custom_domain": true }\n  ]`
      : '$1[]')
    .replace(/("workers_dev":\s*)(true|false)/, `$1${domain ? 'false' : 'true'}`);

  await writeFile(configPath, config);
  return config;
}

/**
 * Eigene Domain: aus `--domain=…`, sonst gefragt. Leere Eingabe heißt
 * workers.dev. Die Antwort landet in wrangler.jsonc, damit jeder Betreiber
 * seine eigene Adresse bekommt und nichts Fremdes im Repo steht.
 */
export async function askDomain(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith('--domain='))?.slice(9).trim();

  // Beide Wege durch dieselbe Prüfung — sonst umgeht das Flag die Validierung.
  const answer = flag
    || await ask('   Custom domain? (e.g. pager.example.com — blank for workers.dev)  ');

  if (!answer) return '';
  if (!looksLikeHostname(answer)) {
    throw new Error(`"${answer}" does not look like a hostname. Stopped — nothing has been changed yet.`);
  }
  return answer.toLowerCase();
}

/**
 * Kontaktadresse fürs VAPID-Subject. Darüber melden sich Apple und Google, wenn
 * mit den Pushes etwas nicht stimmt — sie geht ausschließlich an die
 * Push-Dienste, nie an Nutzer des Space. Vorschlag ist die Kontoadresse.
 */
export async function askSubject(accountEmail, argv = process.argv) {
  const flag = argv.find((a) => a.startsWith('--email='))?.slice(8).trim();
  const chosen = flag || await ask(accountEmail
    ? `   Contact address for Apple and Google? (Enter for ${accountEmail})  `
    : '   Contact address for Apple and Google?  ') || accountEmail;

  if (!chosen) {
    throw new Error('A contact address is required — the push services need a VAPID subject.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chosen)) {
    throw new Error(`"${chosen}" is not an email address. Stopped — nothing has been changed yet.`);
  }
  return chosen;
}
