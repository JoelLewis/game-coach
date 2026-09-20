// POST { token } -> { ok: true, maskedEmail, differentAccount } | { ok: false, error }.
//
// B04: the confirmation page previously offered only a generic "Confirm sign-in" with no
// indication of *which* account the link actually signs in to, so a token from an attacker's own
// magic link (sent to someone else, described as an app sign-in) looked identical to a
// legitimate one. This lets the page show the destination before the click.
//
// Same-origin, JSON, rate limited (B06) exactly like POST /auth/verify. Deliberately:
//   - never consumes the token (peekMagicLinkToken only SELECTs; see players.ts) -- previewing a
//     link must not affect whether it can still be confirmed;
//   - never reveals whether an account already exists for the destination email -- `maskedEmail`
//     is derived only from the token's own recorded email, and `differentAccount` only compares
//     the destination against the CURRENT browser's own signed-in identity, never against the
//     wider set of accounts;
//   - gives an unknown/expired/already-used token the exact same generic failure shape POST
//     /auth/verify already does, so this endpoint can't be used to distinguish those cases either.
import { json } from "@sveltejs/kit";
import * as v from "valibot";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { verifySessionCookie } from "../../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../../lib/server/crypto-utils.ts";
import { readJsonBody } from "../../../../lib/server/http-body.ts";
import { maskEmail } from "../../../../lib/server/mask-email.ts";
import { isJsonContentType } from "../../../../lib/server/origin.ts";
import { accountForEmail, getLiveSessionPlayer, peekMagicLinkToken } from "../../../../lib/server/players.ts";
import { isIpRateLimited } from "../../../../lib/server/rate-limit.ts";
import { applyAuthResponseHeaders } from "../../../../lib/server/security-headers.ts";
import type { RequestHandler } from "./$types";

const PreviewBodySchema = v.object({ token: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)) });

const fail = (status: number, error: string) => applyAuthResponseHeaders(json({ ok: false, error }, { status }));

export const POST: RequestHandler = async ({ request, platform, cookies, getClientAddress }) => {
	if (!platform) return fail(500, "platform_unavailable");
	if (!isJsonContentType(request)) return fail(400, "expected application/json");

	if (await isIpRateLimited(platform.env.RATE_LIMITER, getClientAddress())) return fail(429, "rate_limited");

	// B06: a streamed byte cap runs before any JSON parsing, independent of Content-Length.
	const bodyResult = await readJsonBody(request);
	if (!bodyResult.ok) return fail(bodyResult.reason === "too_large" ? 413 : 400, "invalid_body");
	const parsed = v.safeParse(PreviewBodySchema, bodyResult.body);
	if (!parsed.success) return fail(400, "invalid_body");

	const now = Date.now();
	const db = platform.env.DB;

	// Never log `token`: it's a bearer credential, exactly as in POST /auth/verify.
	const peeked = await peekMagicLinkToken(db, parsed.output.token, now);
	if (!peeked) return fail(400, "expired_or_invalid");

	const rawCookie = cookies.get(SESSION_COOKIE);
	const viewerSessionId = rawCookie ? await verifySessionCookie(rawCookie, platform.env.SESSION_SECRET) : null;
	const viewer = viewerSessionId ? await getLiveSessionPlayer(db, await sha256Hex(viewerSessionId), now) : null;

	// "Different account": the browser is currently signed in as an account, and confirming this
	// link would change who that is -- whether by switching to a different pre-existing account or
	// by creating a brand-new one. Comparing against the viewer's OWN player id (rather than just
	// "does any account already exist for this email") is what keeps an ordinary re-sign-in to the
	// account you're already using from producing a false "switching identity" warning, without
	// ever telling the caller whether the email is new or already claimed.
	let differentAccount = false;
	if (viewer && viewer.playerKind === "account") {
		const destination = await accountForEmail(db, peeked.email);
		differentAccount = !destination || destination.player_id !== viewer.playerId;
	}

	return applyAuthResponseHeaders(json({ ok: true, maskedEmail: maskEmail(peeked.email), differentAccount }, { status: 200 }));
};
