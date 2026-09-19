// Browser <-> GameSession Durable Object, protocol v1. JSON text frames only.
// Path: wss://<host>/ws/game/<gameId>. The session Worker rejects upgrades whose Origin is
// not the app origin or whose session cookie does not own the game.
import * as v from "valibot";
import { CoachModeSchema } from "./decision.ts";
import { MoveFactsSchema } from "./engine.ts";
import { SeverityLevelSchema, ThemeIdSchema } from "./taxonomy.ts";

export const WS_PROTOCOL_VERSION = 1;
export const WS_PATH_PREFIX = "/ws/game/";
export const wsPath = (gameId: string): string => `${WS_PATH_PREFIX}${gameId}`;
export const MAX_FRAME_BYTES = 16_384;

const Ply = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1200));
const MoveText = v.pipe(v.string(), v.minLength(1), v.maxLength(16));

export const GAME_RESULTS = ["player_win", "player_loss", "draw", "abandoned"] as const;
export const GameResultSchema = v.picklist(GAME_RESULTS);
export type GameResult = v.InferOutput<typeof GameResultSchema>;

// --- Client -> server ------------------------------------------------------------------
export const ClientMessageSchema = v.variant("type", [
  // First frame after connect. lastPly is the highest ply the client has applied.
  v.object({ type: v.literal("hello"), version: v.literal(WS_PROTOCOL_VERSION), lastPly: Ply }),
  // A player move with its engine facts. Plies must arrive strictly increasing.
  v.object({ type: v.literal("move"), facts: MoveFactsSchema }),
  // The engine opponent's reply; recorded, never judged.
  v.object({
    type: v.literal("opponent_move"),
    ply: Ply,
    moveId: MoveText,
    moveText: MoveText,
    positionAfter: v.pipe(v.string(), v.maxLength(512)),
  }),
  v.object({ type: v.literal("set_mode"), mode: CoachModeSchema, talkativeness: v.pipe(v.number(), v.minValue(0), v.maxValue(1)) }),
  v.object({ type: v.literal("feedback"), eventId: v.string(), helpful: v.boolean() }),
  v.object({ type: v.literal("game_end"), result: GameResultSchema, finalPosition: v.pipe(v.string(), v.maxLength(512)) }),
]);
export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

// --- Server -> client ------------------------------------------------------------------
export const CoachEventSchema = v.object({
  id: v.string(),
  ply: Ply,
  kind: v.picklist(["interrupt", "praise", "review"]),
  templateId: v.string(),
  text: v.string(),
  source: v.picklist(["template", "model"]),
  themeId: ThemeIdSchema,
  // Board squares (or Go vertices) to highlight, and the line shown on "tap for the best line".
  highlights: v.array(v.string()),
  bestLine: v.array(MoveText),
});
export type CoachEvent = v.InferOutput<typeof CoachEventSchema>;

export const WS_ERROR_CODES = [
  "bad_message",
  "ply_out_of_order",
  "rate_limited",
  "game_over",
  "unsupported_version",
  "internal",
] as const;

export const ServerMessageSchema = v.variant("type", [
  // Reply to hello. serverPly is the highest ply the server has persisted; the client
  // resends any moves after it. recentEvents lets a reconnecting client repaint the panel.
  v.object({
    type: v.literal("ready"),
    serverPly: Ply,
    mode: CoachModeSchema,
    talkativeness: v.number(),
    recentEvents: v.array(CoachEventSchema),
    // True once the server has recorded this game as over (finished/abandoned). Lets a
    // reconnecting client drop a queued `game_end` frame it already sent but never saw
    // acknowledged (see the resend outbox in apps/web's game-socket.svelte.ts). Optional with a
    // `false` default so older senders that don't set it are still schema-valid.
    gameOver: v.optional(v.boolean(), false),
  }),
  // Sent for every judged move: drives the quiet "coach is watching" indicator.
  v.object({
    type: v.literal("judgment"),
    ply: Ply,
    severity: SeverityLevelSchema,
    noted: v.boolean(),
    latencyMs: v.number(),
  }),
  v.object({ type: v.literal("coach"), event: CoachEventSchema }),
  // The move was recorded but not judged (budget exhausted, Jev down, coach off).
  v.object({ type: v.literal("unjudged"), ply: Ply, reason: v.picklist(["budget", "jev_unavailable", "coach_off"]) }),
  v.object({ type: v.literal("error"), code: v.picklist(WS_ERROR_CODES), message: v.string() }),
]);
export type ServerMessage = v.InferOutput<typeof ServerMessageSchema>;

// Application close codes (4000-4999 are reserved for applications).
export const WS_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  game_not_found: 4404,
  superseded: 4409,
  protocol_error: 4422,
  game_over: 4410,
} as const;

// --- Session cookie --------------------------------------------------------------------
// Set by apps/web, verified by both Workers with the shared SESSION_SECRET.
// Value: base64url(sessionId) + "." + base64url(HMAC-SHA256(SESSION_SECRET, sessionId)).
// HttpOnly, Secure, SameSite=Lax, Path=/. The session row maps sessionId -> playerId.
export const SESSION_COOKIE = "gc_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90;
