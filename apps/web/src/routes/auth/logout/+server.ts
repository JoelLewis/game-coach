// POST -> delete the session row and clear the cookie. Idempotent: a missing/invalid cookie
// is not an error.
import { error, json } from "@sveltejs/kit";
import { SESSION_COOKIE } from "@game-coach/contracts/ws-protocol";
import { verifySessionCookie } from "../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../lib/server/crypto-utils.ts";
import { deleteSession } from "../../../lib/server/players.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ platform, cookies }) => {
	if (!platform) error(500, "platform unavailable");

	const rawCookie = cookies.get(SESSION_COOKIE);
	if (rawCookie) {
		const sessionId = await verifySessionCookie(rawCookie, platform.env.SESSION_SECRET);
		if (sessionId) {
			const sessionIdHash = await sha256Hex(sessionId);
			await deleteSession(platform.env.DB, sessionIdHash);
		}
	}
	cookies.delete(SESSION_COOKIE, { path: "/" });
	return json({ loggedOut: true });
};
