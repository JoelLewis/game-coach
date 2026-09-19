// F12: SESSION_SECRET/APP_ORIGIN were never validated before use. An empty or missing secret
// produced a Web Crypto `DataError` only after a guest player/session had already been inserted
// (guest creation commits before signing the cookie), and the thrown error bypassed the hook's
// header application entirely. Both must be checked, and checked BEFORE any identity read or
// write, so a misconfigured deploy fails safely (a controlled 503, security headers included,
// zero database writes) instead of partially succeeding.
const MIN_SESSION_SECRET_BYTES = 32;

export type ConfigValidationResult = { ok: true } | { ok: false; reason: string };

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export const validateEnvConfig = (env: { APP_ORIGIN?: string; SESSION_SECRET?: string }): ConfigValidationResult => {
	if (!env.APP_ORIGIN || env.APP_ORIGIN.length === 0) return { ok: false, reason: "APP_ORIGIN is not configured" };
	if (!env.SESSION_SECRET || env.SESSION_SECRET.length === 0) return { ok: false, reason: "SESSION_SECRET is not configured" };
	if (byteLength(env.SESSION_SECRET) < MIN_SESSION_SECRET_BYTES) {
		return { ok: false, reason: `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes` };
	}
	return { ok: true };
};
