import { describe, expect, it } from "vitest";
import { applySecurityHeaders } from "./security-headers.ts";

describe("applySecurityHeaders", () => {
	it("sets COOP/COEP and the other security headers on the response", () => {
		const response = applySecurityHeaders(new Response("ok"));
		expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
	});

	it("sets a CSP compatible with wasm and same-origin workers", () => {
		const response = applySecurityHeaders(new Response("ok"));
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("'wasm-unsafe-eval'");
		expect(csp).toContain("worker-src 'self'");
		expect(csp).toContain("default-src 'self'");
	});

	it("mutates and returns the same response instance", () => {
		const response = new Response("ok");
		expect(applySecurityHeaders(response)).toBe(response);
	});
});
