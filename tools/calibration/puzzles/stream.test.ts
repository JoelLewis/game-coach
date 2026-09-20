import { describe, expect, it } from "vitest";
import {
  parseCsvLine,
  parsePuzzleRow,
  PUZZLE_DB_URL,
  streamPuzzleSample,
  type PuzzleRow,
  type SpawnZstdLike,
  type ZstdProcess,
} from "./stream.ts";

describe("parseCsvLine", () => {
  it("splits a plain comma-separated line", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("handles a quoted field containing a comma", () => {
    expect(parseCsvLine('00008,r6k/pp2r2p,"e4,e5",1500')).toEqual(["00008", "r6k/pp2r2p", "e4,e5", "1500"]);
  });

  it("handles an escaped quote inside a quoted field", () => {
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(["a", 'say "hi"', "c"]);
  });

  it("returns a single empty field for an empty line", () => {
    expect(parseCsvLine("")).toEqual([""]);
  });
});

const RAW_ROW = [
  "00008",
  "r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24",
  "f2g3 e6e7 b2b1 b3c1 b1c1 h6c1",
  "1760",
  "80",
  "83",
  "72",
  "crushing hangingPiece long middlegame fork",
  "https://lichess.org/787zsVup/black#48",
  "",
  "",
];

describe("parsePuzzleRow", () => {
  it("parses a well-formed row", () => {
    const row = parsePuzzleRow(RAW_ROW);
    expect(row).toEqual({
      puzzleId: "00008",
      fen: "r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24",
      moves: ["f2g3", "e6e7", "b2b1", "b3c1", "b1c1", "h6c1"],
      rating: 1760,
      ratingDeviation: 80,
      popularity: 83,
      nbPlays: 72,
      themes: ["crushing", "hangingPiece", "long", "middlegame", "fork"],
      gameUrl: "https://lichess.org/787zsVup/black#48",
      openingTags: [],
      dailyDate: "",
    } satisfies PuzzleRow);
  });

  it("rejects a row with the wrong number of fields", () => {
    expect(parsePuzzleRow(["a", "b"])).toBeNull();
  });

  it("rejects a row with a non-numeric rating", () => {
    const bad = [...RAW_ROW];
    bad[3] = "not-a-number";
    expect(parsePuzzleRow(bad)).toBeNull();
  });

  it("rejects a row missing its FEN or GameUrl", () => {
    const noFen = [...RAW_ROW];
    noFen[1] = "";
    expect(parsePuzzleRow(noFen)).toBeNull();
  });
});

// A fake zstd process: ignores whatever bytes are written to stdin (tests don't need
// real decompression) and instead streams a pre-built CSV body out of stdout, one chunk
// at a time, so the line-splitting/reservoir logic is exercised the same way it would be
// against the real binary.
const fakeZstd = (csvBody: string, chunkSize = 40): SpawnZstdLike => {
  let killed = false;
  return (): ZstdProcess => ({
    stdin: { write: () => true, end: () => undefined, once: () => undefined },
    kill: () => {
      killed = true;
    },
    stdout: (async function* () {
      for (let i = 0; i < csvBody.length; i += chunkSize) {
        if (killed) return;
        yield Buffer.from(csvBody.slice(i, i + chunkSize), "utf8");
      }
    })(),
  });
};

const header = "PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate";

const makeCsvBody = (rowCount: number): string => {
  const lines = [header];
  for (let i = 0; i < rowCount; i += 1) {
    lines.push(
      `p${i},8/8/8/8/8/8/8/8 w - - 0 1,e2e4 e7e5,${1000 + i},80,90,600,fork middlegame,https://lichess.org/g${i}#1,,`,
    );
  }
  return `${lines.join("\n")}\n`;
};

// Fake fetch: returns a Response-shaped object whose `body` is an async iterable of
// Uint8Array chunks (as real fetch's Response.body is), without needing the network or a
// real Response/ReadableStream. Cast through `unknown` because it deliberately does not
// implement the rest of the Response interface -- streamPuzzleSample only reads
// `.ok`/`.status`/`.body`.
const fakeFetch = (body: string, chunkSize = 30): [((input: string, init?: RequestInit) => Promise<Response>), { calls: { url: string; aborted: boolean }[] }] => {
  const calls: { url: string; aborted: boolean }[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const call = { url, aborted: false };
    calls.push(call);
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      call.aborted = true;
    });
    const bytes = Buffer.from(body, "utf8");
    const asyncBody = (async function* () {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        if (signal?.aborted) return;
        yield bytes.subarray(i, i + chunkSize);
      }
    })();
    return { ok: true, status: 200, body: asyncBody } as unknown as Response;
  };
  return [fetchFn, { calls }];
};

describe("streamPuzzleSample", () => {
  it("skips the header, parses every row, and reservoir-samples down to the requested size", async () => {
    const csv = makeCsvBody(50);
    const [fetchFn] = fakeFetch(csv);
    const result = await streamPuzzleSample(
      { fetchFn, spawnZstd: fakeZstd(csv), zstdPath: "fake-zstd" },
      { url: PUZZLE_DB_URL, reservoirSize: 10, minScanned: 50, seed: "test-seed" },
    );
    expect(result.rowsScanned).toBe(50);
    expect(result.reservoir).toHaveLength(10);
    expect(new Set(result.reservoir.map((r) => r.puzzleId)).size).toBe(10);
  });

  it("is deterministic for a given seed", async () => {
    const csv = makeCsvBody(200);
    const run = async () => {
      const [fetchFn] = fakeFetch(csv);
      return streamPuzzleSample(
        { fetchFn, spawnZstd: fakeZstd(csv), zstdPath: "fake-zstd" },
        { url: PUZZLE_DB_URL, reservoirSize: 20, minScanned: 200, seed: "fixed-seed" },
      );
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.reservoir.map((r) => r.puzzleId)).toEqual(b.reservoir.map((r) => r.puzzleId));
  });

  it("produces a different sample for a different seed", async () => {
    const csv = makeCsvBody(200);
    const [fetchA] = fakeFetch(csv);
    const [fetchB] = fakeFetch(csv);
    const a = await streamPuzzleSample(
      { fetchFn: fetchA, spawnZstd: fakeZstd(csv), zstdPath: "fake-zstd" },
      { url: PUZZLE_DB_URL, reservoirSize: 20, minScanned: 200, seed: "seed-a" },
    );
    const b = await streamPuzzleSample(
      { fetchFn: fetchB, spawnZstd: fakeZstd(csv), zstdPath: "fake-zstd" },
      { url: PUZZLE_DB_URL, reservoirSize: 20, minScanned: 200, seed: "seed-b" },
    );
    expect(a.reservoir.map((r) => r.puzzleId)).not.toEqual(b.reservoir.map((r) => r.puzzleId));
  });

  it("stops early once minScanned rows are seen, aborting the fetch instead of reading the rest", async () => {
    const csv = makeCsvBody(1000);
    const [fetchFn, tracker] = fakeFetch(csv);
    const result = await streamPuzzleSample(
      { fetchFn, spawnZstd: fakeZstd(csv), zstdPath: "fake-zstd" },
      { url: PUZZLE_DB_URL, reservoirSize: 20, minScanned: 100, seed: "s" },
    );
    expect(result.rowsScanned).toBe(100);
    expect(tracker.calls[0]?.aborted).toBe(true);
  });

  it("counts malformed rows without throwing", async () => {
    const csv = `${header}\nbad-row-too-few-fields\n${makeCsvBody(5).split("\n").slice(1).join("\n")}`;
    const [fetchFn] = fakeFetch(csv);
    const result = await streamPuzzleSample(
      { fetchFn, spawnZstd: fakeZstd(csv), zstdPath: "fake-zstd" },
      { url: PUZZLE_DB_URL, reservoirSize: 10, minScanned: 5, seed: "s" },
    );
    expect(result.malformedRows).toBeGreaterThanOrEqual(1);
    expect(result.rowsScanned).toBe(5);
  });
});
