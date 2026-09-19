import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, newId, randomBytes, sha256Hex } from "./crypto-utils.ts";

describe("base64url round trip", () => {
	it("round-trips arbitrary byte lengths, including ones that need padding", () => {
		for (const length of [0, 1, 2, 3, 4, 16, 31, 32, 33, 64]) {
			const bytes = randomBytes(length);
			expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
		}
	});

	it("never emits + / or = (URL-unsafe base64 characters)", () => {
		// A buffer chosen so plain base64 would contain '+', '/' and padding.
		const bytes = new Uint8Array([0xff, 0xef, 0xfe, 0x00]);
		const encoded = bytesToBase64Url(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
	});
});

describe("hex encoding", () => {
	it("encodes bytes as lowercase, zero-padded hex", () => {
		expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
	});
});

describe("sha256Hex", () => {
	it("matches a known SHA-256 vector", async () => {
		const bytes = new TextEncoder().encode("abc");
		expect(await sha256Hex(bytes)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("newId", () => {
	it("produces distinct v4-shaped ids", () => {
		const a = newId();
		const b = newId();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[0-9a-f-]{36}$/);
	});
});
