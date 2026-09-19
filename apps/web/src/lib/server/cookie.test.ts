import { describe, expect, it } from "vitest";
import { bytesToBase64Url, randomBytes } from "./crypto-utils.ts";
import { SESSION_ID_BYTES, signSessionCookie, verifySessionCookie } from "./cookie.ts";

const SECRET = "correct-horse-battery-staple";

describe("signSessionCookie / verifySessionCookie", () => {
	it("round-trips a freshly signed cookie", async () => {
		const sessionId = randomBytes(SESSION_ID_BYTES);
		const cookie = await signSessionCookie(sessionId, SECRET);
		expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		const recovered = await verifySessionCookie(cookie, SECRET);
		expect(recovered).toEqual(sessionId);
	});

	it("rejects a cookie signed with a different secret", async () => {
		const sessionId = randomBytes(SESSION_ID_BYTES);
		const cookie = await signSessionCookie(sessionId, SECRET);
		expect(await verifySessionCookie(cookie, "wrong-secret")).toBeNull();
	});

	it("rejects a tampered sessionId with an unchanged signature", async () => {
		const sessionId = randomBytes(SESSION_ID_BYTES);
		const cookie = await signSessionCookie(sessionId, SECRET);
		const [, signaturePart] = cookie.split(".");
		const tamperedId = randomBytes(SESSION_ID_BYTES);
		const tampered = `${bytesToBase64Url(tamperedId)}.${signaturePart}`;
		expect(await verifySessionCookie(tampered, SECRET)).toBeNull();
	});

	it("rejects a tampered signature", async () => {
		const sessionId = randomBytes(SESSION_ID_BYTES);
		const cookie = await signSessionCookie(sessionId, SECRET);
		const [idPart] = cookie.split(".");
		const badSignature = bytesToBase64Url(randomBytes(32));
		expect(await verifySessionCookie(`${idPart}.${badSignature}`, SECRET)).toBeNull();
	});

	it("rejects truncated values", async () => {
		const sessionId = randomBytes(SESSION_ID_BYTES);
		const cookie = await signSessionCookie(sessionId, SECRET);
		expect(await verifySessionCookie(cookie.slice(0, -10), SECRET)).toBeNull();
	});

	it("rejects a value with no separator", async () => {
		expect(await verifySessionCookie("not-a-valid-cookie", SECRET)).toBeNull();
	});

	it("rejects a value with more than one separator", async () => {
		expect(await verifySessionCookie("a.b.c", SECRET)).toBeNull();
	});

	it("rejects empty parts", async () => {
		expect(await verifySessionCookie(".abc", SECRET)).toBeNull();
		expect(await verifySessionCookie("abc.", SECRET)).toBeNull();
	});

	it("rejects malformed base64url", async () => {
		expect(await verifySessionCookie("not base64!.also not base64!", SECRET)).toBeNull();
	});

	it("rejects a sessionId of the wrong length even with a valid signature for it", async () => {
		const shortId = randomBytes(16);
		const cookie = await signSessionCookie(shortId, SECRET);
		expect(await verifySessionCookie(cookie, SECRET)).toBeNull();
	});
});
