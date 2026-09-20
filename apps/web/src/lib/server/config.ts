// F12: SESSION_SECRET/APP_ORIGIN were never validated before use. An empty or missing secret
// produced a Web Crypto `DataError` only after a guest player/session had already been inserted
// (guest creation commits before signing the cookie), and the thrown error bypassed the hook's
// header application entirely. Both must be checked, and checked BEFORE any identity read or
// write, so a misconfigured deploy fails safely (a controlled 503, security headers included,
// zero database writes) instead of partially succeeding.
const MIN_SESSION_SECRET_BYTES = 32;

export type ConfigValidationResult = { ok: true } | { ok: false; reason: string };

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

export type ConfigEnv = {
	APP_ORIGIN?: string;
	SESSION_SECRET?: string;
	// B03: an absent RATE_LIMITER binding used to mean "isIpRateLimited always returns false" in
	// every environment, silently and indistinguishably from a deliberately unlimited local dev
	// setup. It is now required in every environment except one that explicitly opts out --
	// exactly like SESSION_SECRET/APP_ORIGIN above, checked before any identity read or write.
	RATE_LIMITER?: unknown;
	// Set only in local `.dev.vars` (gitignored, never in wrangler.jsonc) or in tests that
	// deliberately exercise the no-limiter path. Any other value (including unset) does not
	// opt out.
	ALLOW_MISSING_RATE_LIMITER?: string;
};

export const validateEnvConfig = (env: ConfigEnv): ConfigValidationResult => {
	if (!env.APP_ORIGIN || env.APP_ORIGIN.length === 0) return { ok: false, reason: "APP_ORIGIN is not configured" };
	if (!env.SESSION_SECRET || env.SESSION_SECRET.length === 0) return { ok: false, reason: "SESSION_SECRET is not configured" };
	if (byteLength(env.SESSION_SECRET) < MIN_SESSION_SECRET_BYTES) {
		return { ok: false, reason: `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes` };
	}
	if (!env.RATE_LIMITER && env.ALLOW_MISSING_RATE_LIMITER !== "true") {
		return { ok: false, reason: "RATE_LIMITER is not configured (set ALLOW_MISSING_RATE_LIMITER=true in .dev.vars to opt out locally)" };
	}
	return { ok: true };
};
