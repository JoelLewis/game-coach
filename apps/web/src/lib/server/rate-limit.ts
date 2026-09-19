// Thin wrapper around Cloudflare's Rate Limiting binding (`ratelimits` in wrangler.jsonc). This
// is the edge/IP admission control F03 asked for in front of the two endpoints that write to D1
// on behalf of a caller who might not have an identity yet (POST /auth/request, POST
// /api/games): it bounds request volume from a single IP before any database work happens,
// independent of (and much cheaper than) the per-email/per-guest counters in players.ts.
//
// The binding is best-effort and eventually consistent across Cloudflare's edge (see the
// platform docs); it is a blunt instrument, not an exact accounting system, which is fine here
// since it is a backstop, not the only control.
export type RateLimiterBinding = { limit(options: { key: string }): Promise<{ success: boolean }> };

// Local dev without `wrangler dev` (no platform proxy) and preview environments that haven't
// provisioned the binding yet have no rate limiter at all. Fail OPEN in that specific case only
// (unlike missing APP_ORIGIN/SESSION_SECRET, which fail closed): the binding is defense in
// depth, not the primary control, and its absence must not make local development or a fresh
// environment unusable. Every other outcome (configured binding, allowed or denied) is
// authoritative.
export const isIpRateLimited = async (limiter: RateLimiterBinding | undefined, clientAddress: string): Promise<boolean> => {
	if (!limiter) return false;
	const { success } = await limiter.limit({ key: clientAddress });
	return !success;
};
