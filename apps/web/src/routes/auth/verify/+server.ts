// POST { token } -> consumes the magic-link token and completes the identity transition (see
// src/lib/server/players.ts's `completeVerification` for the F01/F02/F08 rules). Deliberately
// has NO GET handler: the emailed link (`#token=...`, a URL fragment) is never sent to the
// server at all, and this route's GET is served by +page.svelte -- a plain confirmation page
// that reads the fragment client-side and POSTs it here from the same origin (F05). That also
// means SvelteKit's auto-generated HEAD (which would otherwise proxy to a GET handler) can't
// consume anything either, since there's no GET handler here to proxy to.
import { json } from "@sveltejs/kit";
import * as v from "valibot";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { setSessionCookie, verifySessionCookie } from "../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../lib/server/crypto-utils.ts";
import { readJsonBody } from "../../../lib/server/http-body.ts";
import { isJsonContentType } from "../../../lib/server/origin.ts";
import { isIpRateLimited } from "../../../lib/server/rate-limit.ts";
import { applyAuthResponseHeaders } from "../../../lib/server/security-headers.ts";
import { VerificationFailedError, completeVerification, consumeMagicLinkToken } from "../../../lib/server/players.ts";
import type { RequestHandler } from "./$types";

const VerifyBodySchema = v.object({ token: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)) });

const fail = (status: number, error: string) => applyAuthResponseHeaders(json({ ok: false, error }, { status }));

// B06: verification previously had no admission control at all -- any non-browser client
// supplying the expected Origin could reach token-consumption parsing without ever holding a
// session or a valid token. The IP limiter now sits in front of this route (and its sibling
// preview endpoint) exactly like the two guest-minting POSTs already had.
export const POST: RequestHandler = async ({ request, platform, cookies, getClientAddress }) => {
	if (!platform) return fail(500, "platform_unavailable");
	if (!isJsonContentType(request)) return fail(400, "expected application/json");

	if (await isIpRateLimited(platform.env.RATE_LIMITER, getClientAddress())) return fail(429, "rate_limited");

	// B06: a streamed byte cap runs before any JSON parsing, independent of Content-Length.
	const bodyResult = await readJsonBody(request);
	if (!bodyResult.ok) return fail(bodyResult.reason === "too_large" ? 413 : 400, "invalid_body");
	const parsed = v.safeParse(VerifyBodySchema, bodyResult.body);
	if (!parsed.success) return fail(400, "invalid_body");

	const now = Date.now();
	const db = platform.env.DB;

	// Never log `token` or the request body: the token is a bearer credential.
	const consumed = await consumeMagicLinkToken(db, parsed.output.token, now);
	if (!consumed) return fail(400, "expired_or_invalid");

	const rawCookie = cookies.get(SESSION_COOKIE);
	const viewerSessionId = rawCookie ? await verifySessionCookie(rawCookie, platform.env.SESSION_SECRET) : null;
	const viewerSessionIdHash = viewerSessionId ? await sha256Hex(viewerSessionId) : null;

	try {
		const outcome = await completeVerification(db, consumed, viewerSessionIdHash, now);
		await setSessionCookie(cookies, outcome.sessionId, platform.env.SESSION_SECRET);
		return applyAuthResponseHeaders(json({ ok: true }, { status: 200 }));
	} catch (err) {
		// F08: never let this escape as an unhandled 500. The token is already consumed (single
		// use, so it can't be replayed either way); report a clean, generic failure instead.
		if (err instanceof VerificationFailedError) return fail(409, "verification_failed");
		throw err;
	}
};
