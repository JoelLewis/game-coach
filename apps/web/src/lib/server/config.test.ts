import { describe, expect, it } from "vitest";
import { validateEnvConfig } from "./config.ts";

const GOOD_SECRET = "a".repeat(32);
const GOOD_ORIGIN = "https://chess.terminal-games.com";
// A stand-in binding shape; validateEnvConfig only ever checks truthiness of RATE_LIMITER, never
// calls it.
const RATE_LIMITER = {};

describe("validateEnvConfig", () => {
	it("accepts a configured origin, a 32+ byte secret, and a rate limiter binding", () => {
		expect(validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: GOOD_SECRET, RATE_LIMITER })).toEqual({ ok: true });
	});

	it("rejects a missing APP_ORIGIN", () => {
		expect(validateEnvConfig({ SESSION_SECRET: GOOD_SECRET, RATE_LIMITER })).toEqual({ ok: false, reason: expect.stringContaining("APP_ORIGIN") });
	});

	it("rejects an empty-string APP_ORIGIN", () => {
		expect(validateEnvConfig({ APP_ORIGIN: "", SESSION_SECRET: GOOD_SECRET, RATE_LIMITER })).toEqual({
			ok: false,
			reason: expect.stringContaining("APP_ORIGIN"),
		});
	});

	it("rejects a missing SESSION_SECRET", () => {
		expect(validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, RATE_LIMITER })).toEqual({
			ok: false,
			reason: expect.stringContaining("SESSION_SECRET"),
		});
	});

	// F12: an empty secret used to produce a Web Crypto DataError deep inside cookie signing,
	// after a guest had already been written to D1. It must be rejected up front instead.
	it("rejects an empty-string SESSION_SECRET", () => {
		expect(validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: "", RATE_LIMITER })).toEqual({
			ok: false,
			reason: expect.stringContaining("SESSION_SECRET"),
		});
	});

	it("rejects a SESSION_SECRET shorter than 32 bytes", () => {
		expect(validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: "short-secret", RATE_LIMITER })).toEqual({
			ok: false,
			reason: expect.stringContaining("32"),
		});
	});

	it("measures secret length in bytes, not UTF-16 code units", () => {
		// 20 multi-byte characters: >32 bytes but well under 32 UTF-16 code units doesn't apply
		// here (20 code units), so use a string whose code-unit length is short but byte length
		// exceeds 32 once encoded as UTF-8.
		const multiByte = "é".repeat(20); // 'é', 2 bytes in UTF-8, 20 code units
		expect(byteLengthOf(multiByte)).toBeGreaterThan(32);
		expect(validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: multiByte, RATE_LIMITER })).toEqual({ ok: true });
	});

	// B03: a missing rate limiter binding used to mean "always allowed", identically in a
	// misconfigured production-like deployment and in local dev. It now fails closed unless
	// explicitly opted out.
	describe("RATE_LIMITER", () => {
		it("rejects a missing RATE_LIMITER binding by default", () => {
			expect(validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: GOOD_SECRET })).toEqual({
				ok: false,
				reason: expect.stringContaining("RATE_LIMITER"),
			});
		});

		it("accepts a missing RATE_LIMITER when ALLOW_MISSING_RATE_LIMITER is exactly 'true'", () => {
			expect(
				validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: GOOD_SECRET, ALLOW_MISSING_RATE_LIMITER: "true" }),
			).toEqual({ ok: true });
		});

		it("does not accept a truthy-looking but non-'true' opt-out value", () => {
			expect(
				validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: GOOD_SECRET, ALLOW_MISSING_RATE_LIMITER: "1" }),
			).toEqual({ ok: false, reason: expect.stringContaining("RATE_LIMITER") });
		});

		it("ignores the opt-out var when a real binding is present", () => {
			expect(
				validateEnvConfig({ APP_ORIGIN: GOOD_ORIGIN, SESSION_SECRET: GOOD_SECRET, RATE_LIMITER, ALLOW_MISSING_RATE_LIMITER: "false" }),
			).toEqual({ ok: true });
		});
	});
});

const byteLengthOf = (value: string): number => new TextEncoder().encode(value).length;
