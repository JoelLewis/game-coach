import { describe, expect, it } from "vitest";
import { validateEnvConfig } from "./config.ts";

const GOOD_SECRET = "a".repeat(32);

describe("validateEnvConfig", () => {
	it("accepts a configured origin and a 32+ byte secret", () => {
		expect(validateEnvConfig({ APP_ORIGIN: "https://chess.terminal-games.com", SESSION_SECRET: GOOD_SECRET })).toEqual({ ok: true });
	});

	it("rejects a missing APP_ORIGIN", () => {
		expect(validateEnvConfig({ SESSION_SECRET: GOOD_SECRET })).toEqual({ ok: false, reason: expect.stringContaining("APP_ORIGIN") });
	});

	it("rejects an empty-string APP_ORIGIN", () => {
		expect(validateEnvConfig({ APP_ORIGIN: "", SESSION_SECRET: GOOD_SECRET })).toEqual({
			ok: false,
			reason: expect.stringContaining("APP_ORIGIN"),
		});
	});

	it("rejects a missing SESSION_SECRET", () => {
		expect(validateEnvConfig({ APP_ORIGIN: "https://chess.terminal-games.com" })).toEqual({
			ok: false,
			reason: expect.stringContaining("SESSION_SECRET"),
		});
	});

	// F12: an empty secret used to produce a Web Crypto DataError deep inside cookie signing,
	// after a guest had already been written to D1. It must be rejected up front instead.
	it("rejects an empty-string SESSION_SECRET", () => {
		expect(validateEnvConfig({ APP_ORIGIN: "https://chess.terminal-games.com", SESSION_SECRET: "" })).toEqual({
			ok: false,
			reason: expect.stringContaining("SESSION_SECRET"),
		});
	});

	it("rejects a SESSION_SECRET shorter than 32 bytes", () => {
		expect(validateEnvConfig({ APP_ORIGIN: "https://chess.terminal-games.com", SESSION_SECRET: "short-secret" })).toEqual({
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
		expect(validateEnvConfig({ APP_ORIGIN: "https://chess.terminal-games.com", SESSION_SECRET: multiByte })).toEqual({ ok: true });
	});
});

const byteLengthOf = (value: string): number => new TextEncoder().encode(value).length;
