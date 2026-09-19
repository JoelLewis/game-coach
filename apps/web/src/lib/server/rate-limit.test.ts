import { describe, expect, it, vi } from "vitest";
import { isIpRateLimited } from "./rate-limit.ts";

describe("isIpRateLimited", () => {
	it("is not limited when the binding allows the request", async () => {
		const limiter = { limit: vi.fn(async () => ({ success: true })) };
		expect(await isIpRateLimited(limiter, "1.2.3.4")).toBe(false);
		expect(limiter.limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
	});

	it("is limited when the binding denies the request", async () => {
		const limiter = { limit: vi.fn(async () => ({ success: false })) };
		expect(await isIpRateLimited(limiter, "1.2.3.4")).toBe(true);
	});

	it("fails open (not limited) when the binding is unconfigured, e.g. local dev", async () => {
		expect(await isIpRateLimited(undefined, "1.2.3.4")).toBe(false);
	});

	it("keys the check on the caller's address, not a shared key", async () => {
		const limiter = { limit: vi.fn(async () => ({ success: true })) };
		await isIpRateLimited(limiter, "9.9.9.9");
		expect(limiter.limit).toHaveBeenCalledWith({ key: "9.9.9.9" });
	});
});
