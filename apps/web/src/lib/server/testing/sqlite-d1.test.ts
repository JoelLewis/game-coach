import { describe, expect, it } from "vitest";
import { SqliteD1 } from "./sqlite-d1.ts";

describe("SqliteD1", () => {
	it("applies the migration and supports prepare/bind/run/first/all", async () => {
		const db = new SqliteD1();
		await db
			.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, 'guest', NULL, ?)")
			.bind("p1", 1000)
			.run();

		const found = await db.prepare("SELECT * FROM players WHERE id = ?").bind("p1").first<{ id: string }>();
		expect(found?.id).toBe("p1");

		const missing = await db.prepare("SELECT * FROM players WHERE id = ?").bind("nope").first();
		expect(missing).toBeNull();

		const all = await db.prepare("SELECT * FROM players").all<{ id: string }>();
		expect(all.results.map((r) => r.id)).toEqual(["p1"]);
		db.close();
	});

	it("supports RETURNING on UPDATE, for atomic single-use token consumption", async () => {
		const db = new SqliteD1();
		await db
			.prepare(
				"INSERT INTO magic_link_tokens (token_hash, email, guest_player_id, expires_at, used_at) VALUES (?, ?, NULL, ?, NULL)",
			)
			.bind("hash1", "a@example.com", 5000)
			.run();

		const first = await db
			.prepare("UPDATE magic_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING email")
			.bind(1000, "hash1")
			.run<{ email: string }>();
		expect(first.results).toEqual([{ email: "a@example.com" }]);

		const second = await db
			.prepare("UPDATE magic_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING email")
			.bind(2000, "hash1")
			.run<{ email: string }>();
		expect(second.results).toEqual([]);
		db.close();
	});

	it("runs batch() atomically: an error in one statement rolls back the others", async () => {
		const db = new SqliteD1();
		await db
			.prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, 'guest', NULL, ?)")
			.bind("p1", 1000)
			.run();

		await expect(
			db.batch([
				db.prepare("UPDATE players SET kind = 'account' WHERE id = ?").bind("p1"),
				// CHECK constraint violation: rolls the whole batch back.
				db.prepare("UPDATE players SET kind = 'robot' WHERE id = ?").bind("p1"),
			]),
		).rejects.toThrow();

		const row = await db.prepare("SELECT kind FROM players WHERE id = ?").bind("p1").first<{ kind: string }>();
		expect(row?.kind).toBe("guest");
		db.close();
	});
});
