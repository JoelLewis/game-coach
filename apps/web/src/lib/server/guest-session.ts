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
import { DEFAULT_GUEST_MINT_DAILY_CAP, createGuestPlayerAndSession } from "./players.ts";

export type GuestSessionLocals = { playerId: string | null; playerKind: "guest" | "account" | null };

// B03: parses the deployed cap var, falling back to the built-in default for anything absent or
// not a positive integer, rather than letting a bad var value disable the cap entirely.
export const parseGuestMintDailyCap = (rawValue: string | undefined): number => {
	if (!rawValue) return DEFAULT_GUEST_MINT_DAILY_CAP;
	const parsed = Number(rawValue);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_GUEST_MINT_DAILY_CAP;
};

// Returns the existing identity if the request already has one (an account or a guest from an
// earlier visit); otherwise mints a fresh guest, sets its cookie, and updates `locals` in place
// so the rest of the request sees it exactly as if hooks.server.ts had resolved it. Propagates
// `GuestMintCapExceededError` (players.ts) to the caller when B03's global daily cap is
// exhausted; route handlers turn that into a controlled 503.
export const ensureGuestPlayer = async (
	db: D1Like,
	secret: string,
	cookies: Cookies,
	locals: GuestSessionLocals,
	now: number,
	guestMintDailyCap?: string,
): Promise<string> => {
	if (locals.playerId) return locals.playerId;

	const guest = await createGuestPlayerAndSession(db, now, parseGuestMintDailyCap(guestMintDailyCap));
	locals.playerId = guest.playerId;
	locals.playerKind = "guest";
	await setSessionCookie(cookies, guest.sessionId, secret);
	return guest.playerId;
};
