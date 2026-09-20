import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask-email.ts";

describe("maskEmail", () => {
	it("masks the local part and domain, keeping the TLD intact", () => {
		expect(maskEmail("jane@gmail.com")).toBe("j•••@g•••.com");
	});

	it("keeps a multi-label TLD's last label intact and masks the rest of the domain", () => {
		expect(maskEmail("a@mail.example.co.uk")).toBe("a•••@m•••.uk");
	});

	it("never reveals more than the first character of the local part", () => {
		const masked = maskEmail("verylongusername@example.com");
		expect(masked.startsWith("v•••@")).toBe(true);
		expect(masked).not.toContain("erylongusername");
	});

	it("never reveals more than the first character of the domain name", () => {
		expect(maskEmail("x@subtledomain.io")).not.toContain("ubtledomain");
	});

	it("does not throw on a domain with no dot", () => {
		expect(() => maskEmail("a@localhost")).not.toThrow();
		expect(maskEmail("a@localhost")).toBe("a•••@l•••");
	});

	it("does not throw on input with no @ at all", () => {
		expect(() => maskEmail("not-an-email")).not.toThrow();
	});
});
