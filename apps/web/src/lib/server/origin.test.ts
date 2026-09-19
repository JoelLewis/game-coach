import { describe, expect, it } from "vitest";
import { isAllowedJsonOrigin, isStateChangingRequest } from "./origin.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";

const jsonRequest = (method: string, origin: string | null): Request => {
	const headers = new Headers({ "content-type": "application/json" });
	if (origin) headers.set("origin", origin);
	return new Request(`${APP_ORIGIN}/api/games`, { method, headers });
};

describe("isStateChangingRequest", () => {
	it("flags POST/PUT/PATCH/DELETE, not GET/HEAD", () => {
		expect(isStateChangingRequest(new Request(APP_ORIGIN, { method: "GET" }))).toBe(false);
		expect(isStateChangingRequest(new Request(APP_ORIGIN, { method: "HEAD" }))).toBe(false);
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			expect(isStateChangingRequest(new Request(APP_ORIGIN, { method }))).toBe(true);
		}
	});
});

describe("isAllowedJsonOrigin", () => {
	it("allows a matching Origin on a JSON POST", () => {
		expect(isAllowedJsonOrigin(jsonRequest("POST", APP_ORIGIN), APP_ORIGIN)).toBe(true);
	});

	it("rejects a mismatched Origin on a JSON POST", () => {
		expect(isAllowedJsonOrigin(jsonRequest("POST", "https://evil.example"), APP_ORIGIN)).toBe(false);
	});

	it("rejects a missing Origin on a JSON POST", () => {
		expect(isAllowedJsonOrigin(jsonRequest("POST", null), APP_ORIGIN)).toBe(false);
	});

	it("does not check Origin on GET requests", () => {
		const headers = new Headers({ "content-type": "application/json", origin: "https://evil.example" });
		const request = new Request(`${APP_ORIGIN}/api/games/1`, { method: "GET", headers });
		expect(isAllowedJsonOrigin(request, APP_ORIGIN)).toBe(true);
	});

	it("does not check Origin on non-JSON state-changing requests (SvelteKit's own CSRF guard covers those)", () => {
		const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" });
		const request = new Request(APP_ORIGIN, { method: "POST", headers });
		expect(isAllowedJsonOrigin(request, APP_ORIGIN)).toBe(true);
	});
});
