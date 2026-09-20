// F11: static assets (prerendered HTML included) bypass hooks.server.ts entirely and are served
// straight from `_headers` (see security-headers.ts's file comment). This locks in that the
// conservative static CSP promised there is actually present, rather than only living in a
// comment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HEADERS_PATH = join(import.meta.dirname, "../../../_headers");

describe("_headers (static asset headers)", () => {
	const contents = readFileSync(HEADERS_PATH, "utf8");
	const cspLine = contents.split("\n").find((line) => line.trim().startsWith("Content-Security-Policy:"));

	it("sets a Content-Security-Policy for static responses", () => {
		expect(cspLine).toBeDefined();
	});

	it("denies framing and disallows plugin objects", () => {
		expect(cspLine).toContain("frame-ancestors 'none'");
		expect(cspLine).toContain("object-src 'none'");
	});

	it("restricts default-src, base-uri, and form-action to same-origin", () => {
		expect(cspLine).toContain("default-src 'self'");
		expect(cspLine).toContain("base-uri 'self'");
		expect(cspLine).toContain("form-action 'self'");
	});

	it("also carries X-Frame-Options: DENY as a frame-ancestors fallback", () => {
		expect(contents).toContain("X-Frame-Options: DENY");
	});
});
