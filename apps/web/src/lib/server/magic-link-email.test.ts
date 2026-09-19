import { describe, expect, it } from "vitest";
import { buildMagicLinkEmail } from "./magic-link-email.ts";

describe("buildMagicLinkEmail", () => {
	it("includes the verify link in both the text and html bodies", () => {
		const url = "https://chess.terminal-games.com/auth/verify?token=abc123";
		const email = buildMagicLinkEmail(url);
		expect(email.subject).toContain("GameCoach");
		expect(email.text).toContain(url);
		expect(email.html).toContain(url);
	});

	it("mentions the 15 minute expiry and single use", () => {
		const email = buildMagicLinkEmail("https://chess.terminal-games.com/auth/verify?token=x");
		expect(email.text).toMatch(/15 minutes/);
		expect(email.text).toMatch(/once/);
	});

	it("escapes HTML-significant characters in the url for the html body", () => {
		const url = "https://chess.terminal-games.com/auth/verify?token=a&b<c>";
		const email = buildMagicLinkEmail(url);
		expect(email.html).not.toContain("token=a&b<c>");
		expect(email.html).toContain("a&amp;b&lt;c&gt;");
	});
});
