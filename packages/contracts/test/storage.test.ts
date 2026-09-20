import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { kvKeys, r2Keys, utcDay } from "../src/storage.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../../db/migrations");

// Every migration file, in filename order (0001, 0002, 0003, ...) — the same order D1 applies
// them in production.
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"));

const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return db;
};

// Column names per table, in the order all migrations applied in order leave them, matching the
// row types in storage.ts.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  players: ["id", "kind", "merged_into", "created_at"],
  player_profiles: ["player_id", "game", "rating_band", "thresholds_json", "updated_at"],
  games: ["id", "player_id", "game", "source", "status", "result", "config_json", "r2_key", "last_ply", "started_at", "ended_at"],
  moves: ["game_id", "ply", "by_player", "move_id", "move_text", "eval_before", "eval_after", "swing", "best_line_json", "features_json", "phase", "clock_ms"],
  judgments: [
    "game_id",
    "ply",
    "jev_model",
    "transport",
    "state_hash",
    "answers_json",
    "decision_json",
    "action_taken",
    "latency_ms",
    "input_tokens",
    "created_at",
    "decided_by",
    "practical_loss",
    "shadow_status",
    "shadow_answers_json",
    "shadow_decision_json",
    "shadow_latency_ms",
    "shadow_input_tokens",
  ],
  coaching_events: ["id", "game_id", "ply", "kind", "template_id", "theme_id", "text", "source", "helpful", "created_at"],
  accounts: ["id", "email", "player_id", "created_at"],
  magic_link_tokens: ["token_hash", "email", "guest_player_id", "expires_at", "used_at"],
  sessions: ["id_hash", "player_id", "expires_at", "created_at"],
  usage_daily: ["player_id", "day", "games", "jev_calls", "jev_input_tokens", "writer_calls"],
};

describe("db/migrations applied in order", () => {
  it("finds every migration file", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(3);
  });

  it("applies cleanly and matches the row types", () => {
    const db = freshDb();
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
      expect(actual, table).toEqual(columns);
    }
    db.close();
  });

  it("enforces enumerated columns", () => {
    const db = freshDb();
    expect(() => db.exec("INSERT INTO players VALUES ('p1', 'robot', NULL, 0)")).toThrow();
    db.exec("INSERT INTO players VALUES ('p1', 'guest', NULL, 0)");
    db.close();
  });

  it("0003_shadow_judgments.sql: defaults decided_by to 'jev' and leaves the shadow columns nullable", () => {
    const db = freshDb();
    db.exec("INSERT INTO players VALUES ('p1', 'guest', NULL, 0)");
    db.exec(
      `INSERT INTO games (id, player_id, game, source, status, result, config_json, r2_key, last_ply, started_at, ended_at)
        VALUES ('g1', 'p1', 'chess', 'played', 'live', NULL, '{}', NULL, 0, 0, NULL)`,
    );
    db.exec(
      `INSERT INTO judgments (game_id, ply, jev_model, transport, state_hash, answers_json, decision_json, action_taken, latency_ms, input_tokens, created_at)
        VALUES ('g1', 1, 'none', 'none', 'h', '{}', '{}', 'queued', 0, 0, 0)`,
    );
    const row = db.prepare("SELECT decided_by, practical_loss, shadow_status FROM judgments WHERE game_id = 'g1' AND ply = 1").get();
    expect(row).toEqual({ decided_by: "jev", practical_loss: null, shadow_status: null });
    db.close();
  });
});

describe("key builders", () => {
  it("builds R2 and KV keys", () => {
    expect(r2Keys.stateBlock("abc")).toBe("state/abc.json");
    expect(r2Keys.gameRecord("chess", "g1")).toBe("games/chess/g1.pgn");
    expect(r2Keys.gameRecord("go", "g1")).toBe("games/go/g1.sgf");
    expect(kvKeys.templates(3, "chess")).toBe("tpl:v3:chess");
  });

  it("formats UTC days", () => {
    expect(utcDay(Date.UTC(2026, 8, 18, 23, 59))).toBe("2026-09-18");
  });
});
