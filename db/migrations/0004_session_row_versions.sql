-- R1 security-review fixes (2026-09-20, docs/reviews/2026-09-20-session-and-auth-rereview.md Part A).
--
-- A06/A07: `version` lets a flush acknowledge only the exact row it sent (a shadow-completion or
-- feedback write that lands mid-flush must not be silently discarded by an older acknowledgement)
-- and lets D1 refuse a stale/late batch that would overwrite a newer row (see apps/session's
-- ON CONFLICT ... WHERE guards in src/d1-flush.ts). Moves are never rewritten after insert, so
-- they do not need a version column.
ALTER TABLE judgments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE coaching_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- A09: the shadow judgment's own archived-state hash and the actual model/transport that
-- produced it, distinct from the live decision's sentinel columns (jev_model/transport =
-- 'none' for an engine_facts row). NULL until a shadow result is recorded.
ALTER TABLE judgments ADD COLUMN shadow_state_hash TEXT;
ALTER TABLE judgments ADD COLUMN shadow_model TEXT;
ALTER TABLE judgments ADD COLUMN shadow_transport TEXT;

-- A08: usage flushes are not idempotent today (a lost acknowledgement double-counts on retry).
-- Each GameSession usage delta is now persisted DO-side as an outbox row with a unique id and the
-- UTC day the Jev call actually happened, then applied here exactly once per id. usage_daily is
-- recomputed from this table's sums for the affected (player_id, day) pairs on every flush, so a
-- replayed flush (same ids) is a true no-op instead of adding the delta again.
CREATE TABLE usage_outbox_applied (
  id               TEXT PRIMARY KEY,
  player_id        TEXT NOT NULL REFERENCES players(id),
  day              TEXT NOT NULL,
  jev_calls        INTEGER NOT NULL,
  jev_input_tokens INTEGER NOT NULL,
  applied_at       INTEGER NOT NULL
);
CREATE INDEX usage_outbox_applied_by_player_day ON usage_outbox_applied (player_id, day);
