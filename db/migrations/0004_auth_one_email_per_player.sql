-- Auth re-review fixes (2026-09-20 session-and-auth re-review, Part B). See
-- docs/reviews/2026-09-20-session-and-auth-rereview.md.
--
-- B01/B02: a magic-link identity transition (promote-or-create, the accounts insert, a losing
-- guest's merge, revocation of the source guest's sessions/sibling tokens, and the new session)
-- now runs as ONE conditional db.batch in src/lib/server/players.ts. This unique index is the
-- storage-level backstop for that: even if the application logic above it were ever wrong, SQLite
-- itself refuses to let a second accounts row point at a player that already has one, so a second
-- email can never attach to an account. Written defensively (not a "clean up duplicates first"
-- migration): if this fails, it means live duplicate (email, player_id) pairs already exist and
-- must be resolved by hand before this ships -- silently deleting rows to make the index buildable
-- would destroy account data, which is worse than a loud migration failure. There is no production
-- data yet, so this is not expected to happen.
CREATE UNIQUE INDEX accounts_by_player ON accounts (player_id);

-- B05: cleanupExpiredAuthRows (players.ts) filters both tables by expires_at alone. The existing
-- indexes are (email, expires_at) and (player_id) / (guest_player_id, expires_at) -- none of them
-- let SQLite seek straight to the expired rows without a full table scan when the table is mostly
-- live rows. These are leading-column indexes on exactly the column cleanup filters by; see
-- src/lib/server/players-explain.test.ts, which asserts via EXPLAIN QUERY PLAN that cleanup uses
-- them instead of scanning.
CREATE INDEX magic_link_tokens_by_expiry ON magic_link_tokens (expires_at);
CREATE INDEX sessions_by_expiry ON sessions (expires_at);

-- B03: a single row per UTC day, checked and incremented atomically (in the same db.batch that
-- mints a guest -- see createGuestPlayerAndSession in players.ts) to cap total guest minting
-- across all distributed traffic, independent of and in addition to the per-IP rate limiter.
-- `last_admission` records the player id that most recently passed the cap check; it lets the
-- very next statement in the same batch (the players INSERT) prove it was THIS call that was
-- admitted, rather than merely reading the day's count back afterward (which cannot distinguish
-- "we were admitted" from "someone else already was, and the count happens to be under the cap").
CREATE TABLE guest_mint_daily (
  day            TEXT PRIMARY KEY,
  count          INTEGER NOT NULL DEFAULT 0,
  last_admission TEXT
);
