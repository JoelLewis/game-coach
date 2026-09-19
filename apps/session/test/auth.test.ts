import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  authenticatePlayer,
  authenticateWsRequest,
  checkGameOwnership,
  isAllowedOrigin,
  resolvePlayerId,
  verifySessionCookie,
} from "../src/auth.ts";
import { WS_CLOSE } from "@game-coach/contracts/ws-protocol";
import { seedGame, seedPlayer, seedSession, signSessionCookie } from "./fixtures.ts";

describe("isAllowedOrigin", () => {
  it("accepts an exact match", () => {
    expect(isAllowedOrigin("https://chess.terminal-games.com", "https://chess.terminal-games.com")).toBe(true);
  });

  it("rejects a mismatched origin", () => {
    expect(isAllowedOrigin("https://evil.example", "https://chess.terminal-games.com")).toBe(false);
  });

  it("rejects a missing origin header", () => {
    expect(isAllowedOrigin(null, "https://chess.terminal-games.com")).toBe(false);
  });

  it("allows the Vite dev server only when APP_ORIGIN itself is localhost", () => {
    expect(isAllowedOrigin("http://localhost:5173", "http://localhost:8787")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "https://chess.terminal-games.com")).toBe(false);
  });
});

describe("verifySessionCookie", () => {
  it("round-trips a cookie signed with the same secret", async () => {
    const cookie = await signSessionCookie("session-abc", "secret-1-padded-to-at-least-32-bytes!");
    const result = await verifySessionCookie(cookie, "secret-1-padded-to-at-least-32-bytes!");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result)).toBe("session-abc");
  });

  it("rejects every cookie when the secret is missing or shorter than 32 bytes", async () => {
    const cookie = await signSessionCookie("session-abc", "short");
    expect(await verifySessionCookie(cookie, "short")).toBeUndefined();
    expect(await verifySessionCookie(cookie, "")).toBeUndefined();
  });

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await signSessionCookie("session-abc", "secret-1-padded-to-at-least-32-bytes!");
    expect(await verifySessionCookie(cookie, "secret-2-padded-to-at-least-32-bytes!")).toBeUndefined();
  });

  it("rejects a malformed cookie with no separator", async () => {
    expect(await verifySessionCookie("not-a-valid-cookie", "secret-1-padded-to-at-least-32-bytes!")).toBeUndefined();
  });

  it("rejects a tampered MAC", async () => {
    const cookie = await signSessionCookie("session-abc", "secret-1-padded-to-at-least-32-bytes!");
    const [id] = cookie.split(".");
    expect(await verifySessionCookie(`${id}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, "secret-1-padded-to-at-least-32-bytes!")).toBeUndefined();
  });
});

describe("resolvePlayerId / authenticatePlayer", () => {
  it("resolves a guest merged into an account", async () => {
    await seedPlayer(env.DB, "acct-1", "account");
    await seedPlayer(env.DB, "guest-1", "guest", "acct-1");
    expect(await resolvePlayerId(env.DB, "guest-1")).toBe("acct-1");
    expect(await resolvePlayerId(env.DB, "acct-1")).toBe("acct-1");
  });

  it("returns undefined for an unknown player", async () => {
    expect(await resolvePlayerId(env.DB, "does-not-exist")).toBeUndefined();
  });

  it("authenticates a valid, unexpired session cookie", async () => {
    await seedPlayer(env.DB, "player-auth-1");
    await seedSession(env.DB, "sess-auth-1", "player-auth-1");
    const cookieHeader = `gc_session=${await signSessionCookie("sess-auth-1", "test-session-secret-at-least-32-bytes-long")}`;
    const playerId = await authenticatePlayer(env.DB, cookieHeader, "test-session-secret-at-least-32-bytes-long", Date.now());
    expect(playerId).toBe("player-auth-1");
  });

  it("rejects an expired session", async () => {
    await seedPlayer(env.DB, "player-auth-2");
    await seedSession(env.DB, "sess-auth-2", "player-auth-2", -1000);
    const cookieHeader = `gc_session=${await signSessionCookie("sess-auth-2", "test-session-secret-at-least-32-bytes-long")}`;
    expect(await authenticatePlayer(env.DB, cookieHeader, "test-session-secret-at-least-32-bytes-long", Date.now())).toBeUndefined();
  });

  it("rejects a missing cookie", async () => {
    expect(await authenticatePlayer(env.DB, null, "test-session-secret-at-least-32-bytes-long", Date.now())).toBeUndefined();
  });
});

describe("checkGameOwnership", () => {
  it("accepts the owning player", async () => {
    await seedPlayer(env.DB, "owner-1");
    await seedGame(env.DB, "game-own-1", "owner-1");
    expect(await checkGameOwnership(env.DB, "game-own-1", "owner-1")).toEqual({ ok: true });
  });

  it("rejects someone else's game", async () => {
    await seedPlayer(env.DB, "owner-2");
    await seedPlayer(env.DB, "intruder-1");
    await seedGame(env.DB, "game-own-2", "owner-2");
    expect(await checkGameOwnership(env.DB, "game-own-2", "intruder-1")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("reports game_not_found for an unknown game", async () => {
    await seedPlayer(env.DB, "owner-3");
    expect(await checkGameOwnership(env.DB, "no-such-game", "owner-3")).toEqual({ ok: false, reason: "game_not_found" });
  });
});

describe("authenticateWsRequest", () => {
  const gameUrl = "https://chess.terminal-games.com/ws/game/game-full-1";

  it("succeeds end to end for a valid origin, cookie and game ownership", async () => {
    await seedPlayer(env.DB, "player-full-1");
    await seedSession(env.DB, "sess-full-1", "player-full-1");
    await seedGame(env.DB, "game-full-1", "player-full-1");
    const cookie = `gc_session=${await signSessionCookie("sess-full-1", "test-session-secret-at-least-32-bytes-long")}`;
    const request = new Request(gameUrl, { headers: { Origin: "https://chess.terminal-games.com", Cookie: cookie } });

    const result = await authenticateWsRequest(request, env, "game-full-1");
    expect(result).toEqual({ ok: true, playerId: "player-full-1" });
  });

  it("rejects a bad origin with WS_CLOSE.unauthorized", async () => {
    const request = new Request(gameUrl, { headers: { Origin: "https://evil.example" } });
    const result = await authenticateWsRequest(request, env, "game-full-1");
    expect(result).toEqual({ ok: false, closeCode: WS_CLOSE.unauthorized, message: expect.any(String) });
  });

  it("rejects a missing/bad cookie with WS_CLOSE.unauthorized", async () => {
    const request = new Request(gameUrl, { headers: { Origin: "https://chess.terminal-games.com" } });
    const result = await authenticateWsRequest(request, env, "game-full-1");
    expect(result).toEqual({ ok: false, closeCode: WS_CLOSE.unauthorized, message: expect.any(String) });
  });

  it("rejects someone else's game with WS_CLOSE.forbidden", async () => {
    await seedPlayer(env.DB, "player-full-2");
    await seedPlayer(env.DB, "owner-full-2");
    await seedSession(env.DB, "sess-full-2", "player-full-2");
    await seedGame(env.DB, "game-full-2", "owner-full-2");
    const cookie = `gc_session=${await signSessionCookie("sess-full-2", "test-session-secret-at-least-32-bytes-long")}`;
    const request = new Request("https://chess.terminal-games.com/ws/game/game-full-2", {
      headers: { Origin: "https://chess.terminal-games.com", Cookie: cookie },
    });
    const result = await authenticateWsRequest(request, env, "game-full-2");
    expect(result).toEqual({ ok: false, closeCode: WS_CLOSE.forbidden, message: expect.any(String) });
  });
});
