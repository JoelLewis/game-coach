// Worker-side auth for `/ws/game/:id`: Origin check, constant-time HMAC cookie verification,
// and D1 session / player-merge / game-ownership lookups. Nothing here trusts client input
// beyond what's cryptographically or relationally verified.
import { SESSION_COOKIE, WS_CLOSE } from "@game-coach/contracts/ws-protocol";

export const isAllowedOrigin = (origin: string | null, appOrigin: string): boolean => {
  if (origin === null) return false;
  if (origin === appOrigin) return true;
  return appOrigin.startsWith("http://localhost") && origin === "http://localhost:5173";
};

const base64UrlDecode = (value: string): Uint8Array | undefined => {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (bytes: Uint8Array): Promise<string> => toHex(await crypto.subtle.digest("SHA-256", bytes));

const parseCookie = (header: string | null, name: string): string | undefined => {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
};

// Cookie value: base64url(sessionId) + "." + base64url(HMAC-SHA256(SESSION_SECRET, sessionId)).
// Returns the raw sessionId bytes only once `crypto.subtle.verify` has confirmed the MAC in
// constant time; the caller hashes them to look up `sessions.id_hash`.
export const verifySessionCookie = async (cookieValue: string, secret: string): Promise<Uint8Array | undefined> => {
  const dot = cookieValue.indexOf(".");
  if (dot < 0) return undefined;

  const sessionIdBytes = base64UrlDecode(cookieValue.slice(0, dot));
  const macBytes = base64UrlDecode(cookieValue.slice(dot + 1));
  if (sessionIdBytes === undefined || macBytes === undefined) return undefined;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("HMAC", key, macBytes, sessionIdBytes);
  return valid ? sessionIdBytes : undefined;
};

// Follows `players.merged_into` to the account a guest was merged into. Bounded so a corrupt
// or cyclic chain can't hang the request.
const MAX_MERGE_HOPS = 8;

export const resolvePlayerId = async (db: D1Database, playerId: string): Promise<string | undefined> => {
  let current = playerId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const row = await db.prepare("SELECT merged_into FROM players WHERE id = ?").bind(current).first<{ merged_into: string | null }>();
    if (row === null) return undefined;
    if (row.merged_into === null) return current;
    current = row.merged_into;
  }
  return undefined;
};

export const authenticatePlayer = async (
  db: D1Database,
  cookieHeader: string | null,
  secret: string,
  now: number,
): Promise<string | undefined> => {
  const cookieValue = parseCookie(cookieHeader, SESSION_COOKIE);
  if (cookieValue === undefined) return undefined;

  const sessionIdBytes = await verifySessionCookie(cookieValue, secret);
  if (sessionIdBytes === undefined) return undefined;

  const idHash = await sha256Hex(sessionIdBytes);
  const row = await db
    .prepare("SELECT player_id, expires_at FROM sessions WHERE id_hash = ?")
    .bind(idHash)
    .first<{ player_id: string; expires_at: number }>();
  if (row === null || row.expires_at <= now) return undefined;

  return resolvePlayerId(db, row.player_id);
};

export type GameOwnership =
  | { ok: true }
  | { ok: false; reason: "game_not_found" | "forbidden" };

export const checkGameOwnership = async (db: D1Database, gameId: string, playerId: string): Promise<GameOwnership> => {
  const row = await db.prepare("SELECT player_id FROM games WHERE id = ?").bind(gameId).first<{ player_id: string }>();
  if (row === null) return { ok: false, reason: "game_not_found" };

  const owner = await resolvePlayerId(db, row.player_id);
  if (owner === undefined || owner !== playerId) return { ok: false, reason: "forbidden" };
  return { ok: true };
};

export type WsAuthResult = { ok: true; playerId: string } | { ok: false; closeCode: number; message: string };

export const authenticateWsRequest = async (
  request: Request,
  env: Pick<Env, "DB" | "SESSION_SECRET" | "APP_ORIGIN">,
  gameId: string,
): Promise<WsAuthResult> => {
  if (!isAllowedOrigin(request.headers.get("Origin"), env.APP_ORIGIN)) {
    return { ok: false, closeCode: WS_CLOSE.unauthorized, message: "origin not allowed" };
  }

  const playerId = await authenticatePlayer(env.DB, request.headers.get("Cookie"), env.SESSION_SECRET, Date.now());
  if (playerId === undefined) {
    return { ok: false, closeCode: WS_CLOSE.unauthorized, message: "missing or invalid session" };
  }

  const ownership = await checkGameOwnership(env.DB, gameId, playerId);
  if (!ownership.ok) {
    const closeCode = ownership.reason === "game_not_found" ? WS_CLOSE.game_not_found : WS_CLOSE.forbidden;
    return { ok: false, closeCode, message: ownership.reason };
  }

  return { ok: true, playerId };
};
