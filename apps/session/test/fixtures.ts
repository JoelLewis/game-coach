// Shared test fixtures: valid MoveFacts/GameConfig builders, D1 seeding helpers and the
// gc_session cookie signer (mirrors `ws-protocol.ts`'s documented format so tests can produce
// cookies exactly like apps/web would).
import type { BestLine, MoveFacts } from "@game-coach/contracts/engine";
import type { GameConfig } from "@game-coach/contracts/session-rpc";

export const bestLine = (moves: string[], cp: number): BestLine => ({ eval: { kind: "cp", cp }, line: moves });

export const moveFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts => ({
  ply: 1,
  moveId: "e2e4",
  moveText: "e4",
  positionBefore: "pos-before",
  positionAfter: "pos-after",
  recentMoves: [],
  // Deliberately not >= -10: that's the heuristic responder's `good_move` threshold, and the
  // default fixture should be an unremarkable "fine" move with nothing to say, not a praise.
  evalBefore: { kind: "cp", cp: 20 },
  evalAfter: { kind: "cp", cp: 0 },
  swing: -20,
  bestLines: [bestLine(["Nf3"], 20)],
  playedLine: ["e4"],
  depth: 12,
  phase: "opening",
  features: {},
  clockMs: 1000,
  ...overrides,
});

// swing <= -200 lands in the "blunder" bucket (see template-candidates.ts's classifySeverityBucket).
export const blunderFacts = (overrides: Partial<MoveFacts> = {}): MoveFacts =>
  moveFacts({
    evalBefore: { kind: "cp", cp: 40 },
    evalAfter: { kind: "cp", cp: -260 },
    swing: -300,
    features: { hanging_piece: true },
    ...overrides,
  });

export const defaultGameConfig = (overrides: Partial<GameConfig> = {}): GameConfig => ({
  game: "chess",
  source: "played",
  playerSide: "white",
  opponentLevel: 3,
  timeControl: "5+3",
  startPosition: "startpos",
  mode: "live",
  talkativeness: 0.5,
  ...overrides,
});

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const sessionIdHash = (sessionId: string): Promise<string> => sha256Hex(new TextEncoder().encode(sessionId));

// gc_session cookie value: base64url(sessionId) + "." + base64url(HMAC-SHA256(secret, sessionId)).
export const signSessionCookie = async (sessionId: string, secret: string): Promise<string> => {
  const idBytes = new TextEncoder().encode(sessionId);
  const key = await hmacKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, idBytes));
  return `${base64Url(idBytes)}.${base64Url(mac)}`;
};

export const seedPlayer = async (
  db: D1Database,
  id: string,
  kind: "guest" | "account" = "guest",
  mergedInto: string | null = null,
): Promise<void> => {
  await db
    .prepare("INSERT INTO players (id, kind, merged_into, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, kind, mergedInto, Date.now())
    .run();
};

export const seedSession = async (
  db: D1Database,
  sessionId: string,
  playerId: string,
  ttlMs = 60 * 60 * 1000,
): Promise<void> => {
  const idHash = await sessionIdHash(sessionId);
  await db
    .prepare("INSERT INTO sessions (id_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(idHash, playerId, Date.now() + ttlMs, Date.now())
    .run();
};

export const seedGame = async (
  db: D1Database,
  gameId: string,
  playerId: string,
  config: GameConfig = defaultGameConfig(),
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO games (id, player_id, game, source, status, result, config_json, r2_key, last_ply, started_at, ended_at)
        VALUES (?, ?, ?, ?, 'live', NULL, ?, NULL, 0, ?, NULL)`,
    )
    .bind(gameId, playerId, config.game, config.source, JSON.stringify(config), Date.now())
    .run();
};
