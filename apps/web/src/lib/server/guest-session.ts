// F03: a guest identity used to be minted by the hook on essentially any request (any
// cookie-less dynamic GET advertising `Accept: text/html`, and any non-GET that passed the
// origin check) -- before route validation, before rate limiting, for invalid routes, HEAD,
// OPTIONS, everything. That made a player+session (two D1 INSERTs, random generation, hashing,
// HMAC signing) essentially free to mint in bulk.
//
// A guest is now minted in exactly two places, both call sites of `ensureGuestPlayer` below:
// POST /auth/request and POST /api/games, and only after Origin/body validation and the IP rate
// limit have already passed. Every other request either has an existing session (resolved by
// hooks.server.ts) or has no identity at all (`locals.playerId === null`).
import type { Cookies } from "@sveltejs/kit";
import { setSessionCookie } from "./cookie.ts";
import type { D1Like } from "./d1-types.ts";
import { createGuestPlayerAndSession } from "./players.ts";

export type GuestSessionLocals = { playerId: string | null; playerKind: "guest" | "account" | null };

// Returns the existing identity if the request already has one (an account or a guest from an
// earlier visit); otherwise mints a fresh guest, sets its cookie, and updates `locals` in place
// so the rest of the request sees it exactly as if hooks.server.ts had resolved it.
export const ensureGuestPlayer = async (
	db: D1Like,
	secret: string,
	cookies: Cookies,
	locals: GuestSessionLocals,
	now: number,
): Promise<string> => {
	if (locals.playerId) return locals.playerId;

	const guest = await createGuestPlayerAndSession(db, now);
	locals.playerId = guest.playerId;
	locals.playerKind = "guest";
	await setSessionCookie(cookies, guest.sessionId, secret);
	return guest.playerId;
};
