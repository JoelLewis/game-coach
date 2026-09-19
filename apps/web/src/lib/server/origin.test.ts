import { describe, expect, it } from "vitest";
import { isJsonContentType, isSameOriginRequest, isStateChangingRequest } from "./origin.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";

const request = (method: string, headers: Record<string, string> = {}): Request =>
	new Request(`${APP_ORIGIN}/api/games`, { method, headers: new Headers(headers) });

describe("isStateChangingRequest", () => {
	it("flags POST/PUT/PATCH/DELETE, not GET/HEAD", () => {
		expect(isStateChangingRequest(request("GET"))).toBe(false);
		expect(isStateChangingRequest(request("HEAD"))).toBe(false);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(isStateChangingRequest(request(method))).toBe(true);
		}
	});
});

describe("isSameOriginRequest", () => {
	it("allows a matching Origin on a JSON POST", () => {
		expect(isSameOriginRequest(request("POST", { origin: APP_ORIGIN, "content-type": "application/json" }), APP_ORIGIN)).toBe(true);
	});

	it("rejects a mismatched Origin on a JSON POST", () => {
		expect(isSameOriginRequest(request("POST", { origin: "https://evil.example", "content-type": "application/json" }), APP_ORIGIN)).toBe(
			false,
		);
	});

	it("rejects a missing Origin on a JSON POST", () => {
		expect(isSameOriginRequest(request("POST", { "content-type": "application/json" }), APP_ORIGIN)).toBe(false);
	});

	it("rejects a literal `Origin: null`", () => {
		expect(isSameOriginRequest(request("POST", { origin: "null", "content-type": "application/json" }), APP_ORIGIN)).toBe(false);
	});

	it("does not check Origin on GET requests", () => {
		expect(isSameOriginRequest(request("GET", { origin: "https://evil.example" }), APP_ORIGIN)).toBe(true);
	});

	// F04: the exploit. A cross-site "simple request" carries no Content-Type at all (or one
	// outside application/json), which used to skip the Origin check entirely.
	it("F04: rejects a mismatched-Origin POST that has no Content-Type header", () => {
		expect(isSameOriginRequest(request("POST", { origin: "https://evil.example" }), APP_ORIGIN)).toBe(false);
	});

	it("F04: rejects a mismatched-Origin POST whose Content-Type is not JSON", () => {
		expect(
			isSameOriginRequest(request("POST", { origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" }), APP_ORIGIN),
		).toBe(false);
	});

	it("F04: still rejects a mismatched-Origin POST for form content types SvelteKit's own guard also covers", () => {
		expect(
			isSameOriginRequest(request("POST", { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }), APP_ORIGIN),
		).toBe(false);
	});
});

describe("isJsonContentType", () => {
	it("accepts application/json, case-insensitively and with parameters", () => {
		expect(isJsonContentType(request("POST", { "content-type": "Application/JSON; charset=utf-8" }))).toBe(true);
	});

	it("rejects a missing or non-JSON Content-Type", () => {
		expect(isJsonContentType(request("POST"))).toBe(false);
		expect(isJsonContentType(request("POST", { "content-type": "text/plain" }))).toBe(false);
	});
});
