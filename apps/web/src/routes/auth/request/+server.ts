// POST { email } -> always 202. Never reveals whether the email has an account, or whether the
// request was throttled: none of those are distinguishable from the outside (F07). This is one
// of the two places a guest identity is minted (F03), and it sits behind an IP rate limit in
// front of any D1 write (also F03).
import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { isJsonContentType } from "../../../lib/server/origin.ts";
import { isIpRateLimited } from "../../../lib/server/rate-limit.ts";
import { applyAuthResponseHeaders } from "../../../lib/server/security-headers.ts";
import { buildMagicLinkEmail } from "../../../lib/server/magic-link-email.ts";
import { cleanupExpiredAuthRows, createMagicLinkToken } from "../../../lib/server/players.ts";
import { ensureGuestPlayer } from "../../../lib/server/guest-session.ts";
import type { RequestHandler } from "./$types";

const RequestBodySchema = v.object({
	email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(320)),
});

const ACCEPTED_BODY = { accepted: true } as const;

// Opportunistic retention cleanup (F13): run it on a small fraction of requests rather than
// every one, via `ctx.waitUntil` so it never adds latency to this response.
const CLEANUP_PROBABILITY = 0.05;

export const POST: RequestHandler = async ({ request, platform, locals, cookies, getClientAddress }) => {
	if (!platform) error(500, "platform unavailable");

	if (!isJsonContentType(request)) error(400, "expected application/json");

	if (await isIpRateLimited(platform.env.RATE_LIMITER, getClientAddress())) {
		return applyAuthResponseHeaders(json({ error: "rate_limited" }, { status: 429 }));
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, "invalid JSON body");
	}

	const parsed = v.safeParse(RequestBodySchema, body);
	if (!parsed.success) error(400, "invalid email");
	const { email } = parsed.output;

	const now = Date.now();
	const db = platform.env.DB;
	const guestPlayerId = await ensureGuestPlayer(db, platform.env.SESSION_SECRET, cookies, locals, now);
	const result = await createMagicLinkToken(db, email, guestPlayerId, now);

	if (result.ok) {
		const verifyUrl = `${platform.env.APP_ORIGIN}/auth/verify#token=${encodeURIComponent(result.token)}`;
		const { subject, text, html } = buildMagicLinkEmail(verifyUrl);
		// F07: send via waitUntil, never awaited, so the response timing and body are identical
		// whether the token was created or the request was throttled, and a delivery failure
		// never surfaces here. Never log the address or the token.
		platform.ctx.waitUntil(
			platform.env.EMAIL.send({ to: email, from: platform.env.EMAIL_FROM, subject, text, html }).catch(() => {
				console.error("magic-link email delivery failed");
			}),
		);
	}

	if (Math.random() < CLEANUP_PROBABILITY) {
		platform.ctx.waitUntil(cleanupExpiredAuthRows(db, now));
	}

	// Same response whether the token was created, the email is unknown, or the request was
	// rate-limited: none of those must be distinguishable from the outside.
	return applyAuthResponseHeaders(json(ACCEPTED_BODY, { status: 202 }));
};
