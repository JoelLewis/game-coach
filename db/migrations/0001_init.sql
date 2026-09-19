-- GameCoach D1 schema. Row types live in packages/contracts/src/storage.ts and must match.
-- Timestamps are Unix epoch milliseconds. *_json columns hold JSON text.

CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('guest', 'account')),
  merged_into TEXT REFERENCES players(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE player_profiles (
  player_id       TEXT NOT NULL REFERENCES players(id),
  game            TEXT NOT NULL CHECK (game IN ('chess', 'go')),
  rating_band     TEXT NOT NULL,
  thresholds_json TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (player_id, game)
);

CREATE TABLE games (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id),
  game        TEXT NOT NULL CHECK (game IN ('chess', 'go')),
  source      TEXT NOT NULL CHECK (source IN ('played', 'imported')),
  status      TEXT NOT NULL CHECK (status IN ('live', 'finished', 'abandoned')),
  result      TEXT CHECK (result IN ('player_win', 'player_loss', 'draw', 'abandoned')),
  config_json TEXT NOT NULL,
  r2_key      TEXT,
  last_ply    INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX games_by_player ON games (player_id, started_at DESC);

CREATE TABLE moves (
  game_id        TEXT NOT NULL REFERENCES games(id),
  ply            INTEGER NOT NULL,
  by_player      INTEGER NOT NULL CHECK (by_player IN (0, 1)),
  move_id        TEXT NOT NULL,
  move_text      TEXT NOT NULL,
  eval_before    INTEGER,
  eval_after     INTEGER,
  swing          INTEGER,
  best_line_json TEXT,
  features_json  TEXT,
  phase          TEXT,
  clock_ms       INTEGER,
  PRIMARY KEY (game_id, ply)
);

-- One row per Jev call. The full state block is in R2 at state/{state_hash}.json.
CREATE TABLE judgments (
  game_id       TEXT NOT NULL REFERENCES games(id),
  ply           INTEGER NOT NULL,
  jev_model     TEXT NOT NULL,
  transport     TEXT NOT NULL,
  state_hash    TEXT NOT NULL,
  answers_json  TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  action_taken  TEXT NOT NULL,
  latency_ms    INTEGER NOT NULL,
  input_tokens  INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (game_id, ply)
);
CREATE INDEX judgments_by_time ON judgments (created_at);

CREATE TABLE coaching_events (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL REFERENCES games(id),
  ply         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('interrupt', 'praise', 'review')),
  template_id TEXT NOT NULL,
  theme_id    TEXT NOT NULL,
  text        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('template', 'model')),
  helpful     INTEGER CHECK (helpful IN (0, 1)),
  created_at  INTEGER NOT NULL
);
CREATE INDEX coaching_events_by_game ON coaching_events (game_id, ply);

CREATE TABLE accounts (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  player_id  TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL
);

-- Only the SHA-256 of the token is stored. Single use, 15 minute TTL.
CREATE TABLE magic_link_tokens (
  token_hash      TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  guest_player_id TEXT REFERENCES players(id),
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);
CREATE INDEX magic_link_tokens_by_email ON magic_link_tokens (email, expires_at);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_player ON sessions (player_id);

CREATE TABLE usage_daily (
  player_id        TEXT NOT NULL REFERENCES players(id),
  day              TEXT NOT NULL,
  games            INTEGER NOT NULL DEFAULT 0,
  jev_calls        INTEGER NOT NULL DEFAULT 0,
  jev_input_tokens INTEGER NOT NULL DEFAULT 0,
  writer_calls     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);
