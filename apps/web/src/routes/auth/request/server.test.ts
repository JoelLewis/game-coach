import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteD1 } from "../../../lib/server/testing/sqlite-d1.ts";
import { createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { POST } from "./+server.ts";

let db: SqliteD1;
let sendEmail: ReturnType<typeof vi.fn>;

const APP_ORIGIN = "https://chess.terminal-games.com";
const GUEST_ID = "guest-1";

beforeEach(async () => {
	db = new SqliteD1();
	sendEmail = vi.fn(async () => ({ messageId: "fake" }));
	await db
		.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, 'guest', NULL, 0)")
		.bind(GUEST_ID)
		.run();
});

const fakePlatform = () => ({
	env: {
		DB: db,
		EMAIL: { send: sendEmail },
		APP_ORIGIN,
		EMAIL_FROM: "coach@terminal-games.com",
		SESSION_SECRET: "test-secret",
	},
});

const call = (email: unknown, playerId = GUEST_ID) => {
	const event = createFakeEvent({
		method: "POST",
		url: `${APP_ORIGIN}/auth/request`,
		jsonBody: { email },
		platform: fakePlatform(),
		locals: { playerId, playerKind: "guest" },
	});
	return invokeHandler(POST, event);
};

describe("POST /auth/request", () => {
	it("responds 202 with an identical body for an email with no account", async () => {
		const response = await call("unknown@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
		expect(sendEmail).toHaveBeenCalledTimes(1);
	});

	it("responds 202 with the same body for an email that already has an account", async () => {
		await db
			.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES ('acct-p', 'account', NULL, 0)")
			.run();
		await db
			.prepare("INSERT INTO accounts (id, email, player_id, created_at) VALUES ('acc1', 'known@example.com', 'acct-p', 0)")
			.run();

		const response = await call("known@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
	});

	it("sends the email with a verify link containing the token", async () => {
		await call("a@example.com");
		expect(sendEmail).toHaveBeenCalledTimes(1);
		const message = sendEmail.mock.calls[0]?.[0] as { to: string; from: string; text: string };
		expect(message.to).toBe("a@example.com");
		expect(message.from).toBe("coach@terminal-games.com");
		expect(message.text).toContain(`${APP_ORIGIN}/auth/verify?token=`);
	});

	it("normalises email case and whitespace", async () => {
		await call("  A@Example.com  ");
		const row = await db.prepare("SELECT email FROM magic_link_tokens").first<{ email: string }>();
		expect(row?.email).toBe("a@example.com");
	});

	it("rejects a malformed email with 400", async () => {
		const response = await call("not-an-email");
		expect(response.status).toBe(400);
		expect(sendEmail).not.toHaveBeenCalled();
	});

	it("still answers 202 once rate-limited, but stops sending email", async () => {
		for (let i = 0; i < 3; i += 1) await call("a@example.com");
		expect(sendEmail).toHaveBeenCalledTimes(3);

		const response = await call("a@example.com");
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: true });
		expect(sendEmail).toHaveBeenCalledTimes(3);
	});
});
