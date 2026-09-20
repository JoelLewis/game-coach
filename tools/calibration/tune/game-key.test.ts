import { describe, expect, it } from "vitest";
import { testItem } from "../consensus/test-helpers.ts";
import { deriveGameKey, GameKeyError } from "./game-key.ts";

describe("deriveGameKey", () => {
  it("prefers source.gameUrl when present", () => {
    const base = testItem("lichess:033UK46w:6");
    const withUrl = { ...base, source: { ...base.source, gameUrl: "https://lichess.org/033UK46w" } };
    expect(deriveGameKey(withUrl)).toBe("https://lichess.org/033UK46w");
  });

  it("falls back to the id's game prefix when gameUrl is null", () => {
    const base = testItem("lichess:033UK46w:6");
    const withoutUrl = { ...base, source: { ...base.source, gameUrl: null } };
    expect(deriveGameKey(withoutUrl)).toBe("lichess:033UK46w");
  });

  it("gives the same key for two moves from the same game, different keys for different games", () => {
    const g1m1 = { ...testItem("lichess:AAAA:1"), source: { kind: "lichess" as const, gameUrl: null, ply: 1 } };
    const g1m2 = { ...testItem("lichess:AAAA:2"), source: { kind: "lichess" as const, gameUrl: null, ply: 2 } };
    const g2m1 = { ...testItem("lichess:BBBB:1"), source: { kind: "lichess" as const, gameUrl: null, ply: 1 } };
    expect(deriveGameKey(g1m1)).toBe(deriveGameKey(g1m2));
    expect(deriveGameKey(g1m1)).not.toBe(deriveGameKey(g2m1));
  });

  it("throws when neither a gameUrl nor an id prefix is available", () => {
    const base = testItem("solo");
    const broken = { ...base, source: { ...base.source, gameUrl: null } };
    expect(() => deriveGameKey(broken)).toThrow(GameKeyError);
  });
});
