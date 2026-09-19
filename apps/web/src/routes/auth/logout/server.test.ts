import { beforeEach, describe, expect, it } from "vitest";
import { signSessionCookie } from "../../../lib/server/cookie.ts";
import { sha256Hex } from "../../../lib/server/crypto-utils.ts";
import { createGuestPlayerAndSession } from "../../../lib/server/players.ts";
import { createFakeCookies, createFakeEvent, invokeHandler } from "../../../lib/server/testing/fake-event.ts";
import { SqliteD1 } from "../../../lib/server/testing/sqlite-d1.ts";
import { POST } from "./+server.ts";

const APP_ORIGIN = "https://chess.terminal-games.com";
const SESSION_SECRET = "test-secret";

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

describe("POST /auth/logout", () => {
	it("deletes the session row and clears the cookie", async () => {
		const guest = await createGuestPlayerAndSession(db, Date.now());
		const cookieValue = await signSessionCookie(guest.sessionId, SESSION_SECRET);
		const cookies = createFakeCookies({ gc_session: cookieValue });

		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/logout`,
			platform: { env: { DB: db, SESSION_SECRET } },
			cookies,
		});
		const response = await invokeHandler(POST, event);
		expect(response.status).toBe(200);

		const hash = await sha256Hex(guest.sessionId);
		expect(await db.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(hash).first()).toBeNull();
		expect(cookies.get("gc_session")).toBeUndefined();
	});

	it("is a no-op (not an error) when there is no cookie", async () => {
		const cookies = createFakeCookies();
		const event = createFakeEvent({
			method: "POST",
			url: `${APP_ORIGIN}/auth/logout`,
			platform: { env: { DB: db, SESSION_SECRET } },
			cookies,
		});
		const response = await invokeHandler(POST, event);
		expect(response.status).toBe(200);
	});
});
