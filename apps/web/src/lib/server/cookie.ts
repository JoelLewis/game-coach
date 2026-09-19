// Session cookie envelope, per packages/contracts/src/ws-protocol.ts (SESSION_COOKIE):
//   base64url(sessionId) + "." + base64url(HMAC-SHA256(SESSION_SECRET, sessionId))
// `sessionId` is 32 random bytes. D1 never sees the raw id, only sha256(sessionId)
// (see crypto-utils.sha256Hex / players.ts). Verification uses crypto.subtle.verify,
// which compares the HMAC in constant time.
import type { Cookies } from "@sveltejs/kit";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "@game-coach/contracts/ws-protocol";
import { base64UrlToBytes, bytesToBase64Url } from "./crypto-utils.ts";

export const SESSION_ID_BYTES = 32;
const COOKIE_PATH = "/";

const textEncoder = new TextEncoder();

const importHmacKey = (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export const signSessionCookie = async (sessionId: Uint8Array, secret: string): Promise<string> => {
	const key = await importHmacKey(secret, "sign");
	// See crypto-utils.sha256Hex for why this cast is safe (plain ArrayBuffer-backed arrays,
	// not SharedArrayBuffer).
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, sessionId as BufferSource));
	return `${bytesToBase64Url(sessionId)}.${bytesToBase64Url(signature)}`;
};

// Returns the raw sessionId only if the signature is present, well-formed and valid for
// `secret`. Any malformed input (wrong shape, truncated, bad base64, tampered signature,
// wrong secret) returns null; callers must treat that identically to "no session".
export const verifySessionCookie = async (cookieValue: string, secret: string): Promise<Uint8Array | null> => {
	const dotIndex = cookieValue.indexOf(".");
	if (dotIndex < 0 || cookieValue.indexOf(".", dotIndex + 1) >= 0) return null;

	const sessionIdPart = cookieValue.slice(0, dotIndex);
	const signaturePart = cookieValue.slice(dotIndex + 1);
	if (sessionIdPart.length === 0 || signaturePart.length === 0) return null;

	let sessionId: Uint8Array;
	let signature: Uint8Array;
	try {
		sessionId = base64UrlToBytes(sessionIdPart);
		signature = base64UrlToBytes(signaturePart);
	} catch {
		return null;
	}
	if (sessionId.length !== SESSION_ID_BYTES) return null;

	const key = await importHmacKey(secret, "verify");
	const valid = await crypto.subtle.verify("HMAC", key, signature as BufferSource, sessionId as BufferSource);
	return valid ? sessionId : null;
};

// Shared cookie-setting shape used by every place that issues a session cookie (hooks.server.ts's
// refresh, guest minting, magic-link verification), so the attributes (HttpOnly, SameSite=Lax,
// Path=/, TTL) can't drift between them.
export const setSessionCookie = async (cookies: Cookies, sessionId: Uint8Array, secret: string): Promise<void> => {
	const cookieValue = await signSessionCookie(sessionId, secret);
	cookies.set(SESSION_COOKIE, cookieValue, {
		path: COOKIE_PATH,
		httpOnly: true,
		sameSite: "lax",
		maxAge: SESSION_TTL_SECONDS,
	});
};
