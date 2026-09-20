// D1 row types (mirror db/migrations/0001_init.sql, extended by 0003_shadow_judgments.sql, exactly)
// and R2 / KV key builders. JSON columns are TEXT in D1; the `...Json` suffix marks a
// serialized column.
import type { ActionTaken, DecidedBy } from "./decision.ts";
import type { GameKind } from "./engine.ts";
import type { GameResult } from "./ws-protocol.ts";

// 0003_shadow_judgments.sql: how the shadow Jev call for a row turned out. `null` means the
// shadow call hasn't finished (or wasn't scheduled) yet; `off` means JEV_MODE was "off" for
// this row, so no shadow was ever attempted.
export const SHADOW_STATUSES = ["ok", "budget", "unavailable", "off"] as const;
export type ShadowStatus = (typeof SHADOW_STATUSES)[number];

export type PlayerRow = {
  id: string;
  kind: "guest" | "account";
  merged_into: string | null;
  created_at: number;
};

export type PlayerProfileRow = {
  player_id: string;
  game: GameKind;
  rating_band: string;
  thresholds_json: string;
  updated_at: number;
};

export type GameRow = {
  id: string;
  player_id: string;
  game: GameKind;
  source: "played" | "imported";
  status: "live" | "finished" | "abandoned";
  result: GameResult | null;
  config_json: string;
  r2_key: string | null;
  last_ply: number;
  started_at: number;
  ended_at: number | null;
};

export type MoveRow = {
  game_id: string;
  ply: number;
  by_player: 0 | 1;
  move_id: string;
  move_text: string;
  // Null for opponent moves, which carry no engine facts.
  eval_before: number | null;
  eval_after: number | null;
  swing: number | null;
  best_line_json: string | null;
  features_json: string | null;
  phase: string | null;
  clock_ms: number | null;
};

export type JudgmentRow = {
  game_id: string;
  ply: number;
  // "none" for an "engine_facts" row: the live coach path never calls Jev, so these Jev-specific
  // NOT NULL columns hold sentinels (jev_model = "none", transport = "none", answers_json = "{}",
  // latency_ms = 0, input_tokens = 0). decision_json / action_taken are always what the player
  // actually experienced, regardless of decided_by.
  jev_model: string;
  transport: string;
  state_hash: string;
  answers_json: string;
  decision_json: string;
  action_taken: ActionTaken;
  latency_ms: number;
  input_tokens: number;
  created_at: number;
  // 0003_shadow_judgments.sql. See judge-facts.ts / judge-jev-shadow.ts (apps/session).
  decided_by: DecidedBy;
  practical_loss: number | null;
  shadow_status: ShadowStatus | null;
  shadow_answers_json: string | null;
  shadow_decision_json: string | null;
  shadow_latency_ms: number | null;
  shadow_input_tokens: number | null;
  // db/migrations/0005_session_row_versions.sql (A09): the shadow call's own archived-state hash
  // and the actual model/transport that produced it. NULL until a shadow result is recorded;
  // distinct from jev_model/transport above, which describe the *live* decision only.
  shadow_state_hash: string | null;
  shadow_model: string | null;
  shadow_transport: string | null;
};

export type CoachingEventRow = {
  id: string;
  game_id: string;
  ply: number;
  kind: "interrupt" | "praise" | "review";
  template_id: string;
  theme_id: string;
  text: string;
  source: "template" | "model";
  helpful: 0 | 1 | null;
  created_at: number;
};

export type AccountRow = {
  id: string;
  email: string;
  player_id: string;
  created_at: number;
};

export type MagicLinkTokenRow = {
  token_hash: string;
  email: string;
  guest_player_id: string | null;
  expires_at: number;
  used_at: number | null;
};

export type SessionRow = {
  id_hash: string;
  player_id: string;
  expires_at: number;
  created_at: number;
};

export type UsageDailyRow = {
  player_id: string;
  day: string;
  games: number;
  jev_calls: number;
  jev_input_tokens: number;
  writer_calls: number;
};

export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
// All timestamps are Unix epoch milliseconds. `day` is a UTC date, YYYY-MM-DD.
export const utcDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

export const r2Keys = {
  stateBlock: (hash: string): string => `state/${hash}.json`,
  gameRecord: (game: GameKind, gameId: string): string =>
    `games/${game}/${gameId}.${game === "chess" ? "pgn" : "sgf"}`,
  calibrationSet: (set: string, version: number): string => `calib/${set}/v${version}.jsonl`,
} as const;

export const kvKeys = {
  // Value: JSON { templates: n, themes: n, thresholds: n } naming the live versions.
  active: "active",
  templates: (version: number, game: GameKind): string => `tpl:v${version}:${game}`,
  themes: (version: number, game: GameKind): string => `themes:v${version}:${game}`,
  thresholds: (version: number): string => `thresholds:v${version}`,
  budget: (version: number): string => `budget:v${version}`,
} as const;
