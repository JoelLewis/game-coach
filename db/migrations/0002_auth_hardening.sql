-- Auth hardening (2026-09-18 security review). See docs/reviews/2026-09-18-auth-security-review.md.
--
-- F13: the per-guest-player live-token count (players.ts createMagicLinkToken) filtered on
-- guest_player_id but the only index covered (email, expires_at); every request scanned the
-- whole table. This index makes that lookup as cheap as the per-email one already was.
CREATE INDEX magic_link_tokens_by_guest ON magic_link_tokens (guest_player_id, expires_at);
