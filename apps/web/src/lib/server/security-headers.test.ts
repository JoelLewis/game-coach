import { describe, expect, it } from "vitest";
import { applyAuthResponseHeaders, applySecurityHeaders } from "./security-headers.ts";

describe("applySecurityHeaders", () => {
	it("sets COOP/COEP and the other baseline headers on the response", () => {
		const response = applySecurityHeaders(new Response("ok"));
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	});

	// F10: CSP is no longer set as a static header here -- it comes from SvelteKit's own `csp`
	// kit config (vite.config.ts), which can issue a nonce/hash that matches what it actually
	// rendered. A static header here would either block the framework's inline bootstrap script
	// or have to be permissive enough to defeat the point of a CSP.
	it("does not set a static Content-Security-Policy", () => {
		const response = applySecurityHeaders(new Response("ok"));
		expect(response.headers.has("Content-Security-Policy")).toBe(false);
	});

	it("mutates and returns the same response instance", () => {
		const response = new Response("ok");
		expect(applySecurityHeaders(response)).toBe(response);
	});
});

describe("applyAuthResponseHeaders", () => {
	it("sets no-store and no-referrer", () => {
		const response = applyAuthResponseHeaders(new Response("ok"));
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
});
