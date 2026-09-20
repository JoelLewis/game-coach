import { describe, expect, it } from "vitest";
import { MAX_JSON_BODY_BYTES, readJsonBody } from "./http-body.ts";

const requestWith = (body: string, headers: Record<string, string> = {}): Request =>
	new Request("https://example.com/x", { method: "POST", body, headers });

describe("readJsonBody", () => {
	it("parses a small, well-formed JSON body", async () => {
		const result = await readJsonBody(requestWith(JSON.stringify({ a: 1 })));
		expect(result).toEqual({ ok: true, body: { a: 1 } });
	});

	it("rejects invalid JSON without throwing", async () => {
		const result = await readJsonBody(requestWith("{not json"));
		expect(result).toEqual({ ok: false, reason: "invalid_json" });
	});

	it("treats an empty body as an empty (undefined) payload rather than a parse error", async () => {
		const result = await readJsonBody(requestWith(""));
		expect(result).toEqual({ ok: true, body: undefined });
	});

	// B06: the cap is a real byte cap, not a Content-Length trust exercise.
	it("rejects a body over the byte cap before it would ever be JSON.parsed", async () => {
		const big = JSON.stringify({ token: "a".repeat(MAX_JSON_BODY_BYTES + 1) });
		const result = await readJsonBody(requestWith(big), MAX_JSON_BODY_BYTES);
		expect(result).toEqual({ ok: false, reason: "too_large" });
	});

	it("accepts a body exactly at the cap", async () => {
		// Pad so the whole body, not just the field, sits right at the boundary.
		const overhead = JSON.stringify({ a: "" }).length;
		const value = "x".repeat(MAX_JSON_BODY_BYTES - overhead);
		const body = JSON.stringify({ a: value });
		expect(body.length).toBe(MAX_JSON_BODY_BYTES);
		const result = await readJsonBody(requestWith(body), MAX_JSON_BODY_BYTES);
		expect(result.ok).toBe(true);
	});

	// A lying (or absent) Content-Length must not matter: the cap is enforced against actual
	// streamed bytes.
	it("enforces the cap even when Content-Length understates the real body size", async () => {
		const big = "a".repeat(MAX_JSON_BODY_BYTES * 2);
		const result = await readJsonBody(requestWith(big, { "content-length": "10" }), MAX_JSON_BODY_BYTES);
		expect(result).toEqual({ ok: false, reason: "too_large" });
	});

	it("returns invalid_json when the request has no body stream at all", async () => {
		const request = new Request("https://example.com/x", { method: "GET" });
		const result = await readJsonBody(request);
		expect(result).toEqual({ ok: false, reason: "invalid_json" });
	});
});
