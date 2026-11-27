-- ROAKSTASAWD HQ — the whole database.
-- One table for everything that is written: posts, replies, chat, direct
-- messages, pins, AI messages, bans, kicks and notices. A row is only ever
-- inserted by the Worker, which has already checked who is asking.

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,               -- as typed
  key         TEXT NOT NULL UNIQUE,        -- lower case, for looking up
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,               -- PBKDF2-SHA256, made on the server
  iter        INTEGER NOT NULL,
  token       TEXT,                        -- sha256 of the session token
  seen        INTEGER NOT NULL DEFAULT 0,  -- last sign-in, ms
  created     INTEGER NOT NULL,
  banned      INTEGER NOT NULL DEFAULT 0,
  ban_reason  TEXT NOT NULL DEFAULT '',
  admin       INTEGER NOT NULL DEFAULT 0,
  kicked      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,     -- chat | post | pin | topic | reply | ai | dm
  thread  TEXT NOT NULL DEFAULT '',  -- topic id for replies, dm id for messages
  by      TEXT NOT NULL,
  body    TEXT NOT NULL,
  tag     TEXT NOT NULL DEFAULT '',
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_kind_at ON posts (kind, at);
CREATE INDEX IF NOT EXISTS posts_thread ON posts (thread, at);
CREATE INDEX IF NOT EXISTS posts_by ON posts (by);

CREATE TABLE IF NOT EXISTS likes (
  post_id TEXT NOT NULL,
  by      TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (post_id, by)
);

CREATE TABLE IF NOT EXISTS bans (
  name    TEXT NOT NULL,
  key     TEXT NOT NULL,
  reason  TEXT NOT NULL DEFAULT '',
  by      TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bans_key ON bans (key);

CREATE TABLE IF NOT EXISTS notices (
  kind TEXT PRIMARY KEY,     -- pins | chat | home
  body TEXT NOT NULL,
  by   TEXT NOT NULL,
  at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kicks (
  name TEXT NOT NULL,
  by   TEXT NOT NULL,
  at   INTEGER NOT NULL
);

-- who is allowed to do admin things. The owner is added by the Worker itself.
CREATE TABLE IF NOT EXISTS admins (
  key TEXT PRIMARY KEY
);
