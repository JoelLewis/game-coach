// B05: "bounded" cleanup (cleanupExpiredAuthRows in players.ts) filters both tables by
// expires_at alone. The pre-existing indexes are (email, expires_at) and (guest_player_id,
// expires_at) / (player_id) -- none of them are leftmost on expires_at, so SQLite had to scan
// the whole table to find the (few) expired rows. Migration 0004 adds expiry-leading indexes;
// this proves via EXPLAIN QUERY PLAN that cleanup now seeks through them instead.
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "./testing/sqlite-d1.ts";

type QueryPlanRow = { detail: string };

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
});

const explain = async (sql: string, ...params: unknown[]): Promise<string[]> => {
	const result = await db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.bind(...params)
		.all<QueryPlanRow>();
	return result.results.map((row) => row.detail);
};

// The exact statements cleanupExpiredAuthRows issues (players.ts), so this stays honest about
// what actually runs, not a hand-written approximation of it.
const CLEANUP_TOKENS_SQL = "DELETE FROM magic_link_tokens WHERE token_hash IN (SELECT token_hash FROM magic_link_tokens WHERE expires_at <= ? LIMIT ?)";
const CLEANUP_SESSIONS_SQL = "DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions WHERE expires_at <= ? LIMIT ?)";

const hasFullTableScan = (details: string[], table: string): boolean => details.some((detail) => detail === `SCAN ${table}` || detail === `SCAN TABLE ${table}`);

describe("B05: expiry-leading indexes", () => {
	it("cleanup's magic_link_tokens subquery seeks the expiry index instead of scanning the table", async () => {
		const details = await explain(CLEANUP_TOKENS_SQL, Date.now(), 50);
		expect(hasFullTableScan(details, "magic_link_tokens")).toBe(false);
		expect(details.some((detail) => detail.includes("magic_link_tokens_by_expiry"))).toBe(true);
	});

	it("cleanup's sessions subquery seeks the expiry index instead of scanning the table", async () => {
		const details = await explain(CLEANUP_SESSIONS_SQL, Date.now(), 50);
		expect(hasFullTableScan(details, "sessions")).toBe(false);
		expect(details.some((detail) => detail.includes("sessions_by_expiry"))).toBe(true);
	});
});
