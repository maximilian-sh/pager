-- pager — Personen, Geräte, Verlauf.
-- Adressiert wird die Person; Geräte hängen nur darunter.
--
-- Namen sind durchgehend klein und einfach-leerzeichig normalisiert. Dadurch
-- ist der Anzeigename zugleich der Schlüssel — es gibt keine zweite
-- Schreibweise, die auseinanderlaufen könnte.

CREATE TABLE IF NOT EXISTS devices (
  id         INTEGER PRIMARY KEY,
  person     TEXT    NOT NULL,        -- "max kallina"
  device     TEXT    NOT NULL,        -- "iphone", "mac", …
  endpoint   TEXT    NOT NULL UNIQUE, -- Re-Registrierung desselben Geräts = Upsert
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_person ON devices(person);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  sender    TEXT    NOT NULL,
  recipient TEXT    NOT NULL,         -- '*' = an alle
  title     TEXT,
  body      TEXT    NOT NULL,
  url       TEXT,
  sent_at   INTEGER NOT NULL,
  delivered INTEGER NOT NULL,         -- Geräte, die die Nachricht angenommen haben
  total     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender, recipient, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(sent_at);
