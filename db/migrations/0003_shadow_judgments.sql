-- Jev demoted to shadow mode (2026-09-19). Measurements in docs/m0-result.md ("M1 preview" and
-- after) showed the live coach needs nothing beyond an engine-facts computation, so the live
-- path now decides in code (packages/coaching-core/src/judge-facts.ts) with no model call. Jev
-- still runs, but only in the shadow: called after the player's frames are already sent, logged
-- against this same row, never shown to the player. See docs/build-plan.md, "Jev in shadow mode".
--
-- decided_by: which layer produced the decision the player actually saw (decision_json /
-- action_taken). "engine_facts" for the live path. Pre-existing rows (from before this
-- migration) were all Jev decisions, hence the default.
--
-- For an "engine_facts" row the existing NOT NULL Jev columns hold sentinels: jev_model = 'none',
-- transport = 'none', answers_json = '{}', latency_ms = 0, input_tokens = 0.
--
-- shadow_status / shadow_*_json / shadow_latency_ms / shadow_input_tokens describe the shadow
-- Jev call for this row, independent of what the player saw: NULL until the shadow call (a
-- waitUntil'd task) finishes, 'off' when JEV_MODE was "off" for this row so no shadow was ever
-- attempted, else 'ok' | 'budget' | 'unavailable'.
ALTER TABLE judgments ADD COLUMN decided_by TEXT NOT NULL DEFAULT 'jev';
ALTER TABLE judgments ADD COLUMN practical_loss REAL;
ALTER TABLE judgments ADD COLUMN shadow_status TEXT;
ALTER TABLE judgments ADD COLUMN shadow_answers_json TEXT;
ALTER TABLE judgments ADD COLUMN shadow_decision_json TEXT;
ALTER TABLE judgments ADD COLUMN shadow_latency_ms INTEGER;
ALTER TABLE judgments ADD COLUMN shadow_input_tokens INTEGER;
