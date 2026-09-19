// GET ?token=... consumes a magic-link token, promotes/merges the guest into an account, and
// rotates the session. Redirects rather than returning JSON: this is a link the browser
// navigates to directly from the user's inbox.
import { error, redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { signSessionCookie, verifySessionCookie } from "../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../lib/server/crypto-utils.ts";
import { consumeMagicLinkToken, rotateSession, upgradeOrMerge } from "../../../lib/server/players.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, platform, locals, cookies }) => {
	if (!platform) error(500, "platform unavailable");

	const token = url.searchParams.get("token");
	if (!token) redirect(303, "/auth/expired");

	const now = Date.now();
	const db = platform.env.DB;
	// Never log `token` or the request URL: the token is a bearer credential.
	const consumed = await consumeMagicLinkToken(db, token, now);
	if (!consumed) redirect(303, "/auth/expired");

	// The token records which guest requested it; that's the guest to promote/merge, even if
	// this GET is happening on a different device than the one that asked for the link (in
	// which case `locals.playerId` here is an unrelated, throwaway guest hooks.server.ts just
	// created for this navigation).
	const guestPlayerId = consumed.guestPlayerId ?? locals.playerId;
	const { playerId } = await upgradeOrMerge(db, consumed.email, guestPlayerId, now);

	// hooks.server.ts already gave this request a valid session cookie (creating a guest one
	// if it didn't have one). Rotate it: new session id for the resolved player, old row gone
	// so the pre-verification session id can't be reused.
	const rawCookie = cookies.get(SESSION_COOKIE);
	const currentSessionId = rawCookie ? await verifySessionCookie(rawCookie, platform.env.SESSION_SECRET) : null;
	if (!currentSessionId) error(500, "missing session");
	const oldSessionIdHash = await sha256Hex(currentSessionId);

	const rotated = await rotateSession(db, oldSessionIdHash, playerId, now);
	const cookieValue = await signSessionCookie(rotated.sessionId, platform.env.SESSION_SECRET);
	cookies.set(SESSION_COOKIE, cookieValue, {
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		maxAge: SESSION_TTL_SECONDS,
	});

	redirect(303, "/");
};
