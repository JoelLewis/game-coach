// Streams the Lichess puzzle database (CC0, https://database.lichess.org/ "Puzzles"
// section, verified 2026-09) over HTTPS, decompresses it through the `zstd -dc` CLI, and
// reservoir-samples rows as they go past -- the archive (a few hundred MB compressed,
// ~2GB+ decompressed as of 2026) is never written to disk and never fully buffered in
// memory. `--scan` rows in, once the reservoir is full, the HTTP connection and the zstd
// process are both closed early: this is a single, short-lived download per run, not a
// full-database ingest.
//
// Verified against the live page (2026-09):
//   URL:     https://database.lichess.org/lichess_db_puzzle.csv.zst
//   License: CC0 1.0 (Creative Commons Zero -- public domain dedication)
//   Columns: PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity, NbPlays, Themes,
//            GameUrl, OpeningTags, DailyDate
// `FEN` is the position BEFORE the opponent's mistake; `Moves[0]` (space-separated UCI) is
// that mistake; `Moves[1..]` is Lichess's engine-computed winning continuation.
import { spawn } from "node:child_process";
import { createRng } from "../ingest/sample.ts";
import { USER_AGENT, type FetchLike } from "../ingest/http.ts";

export const PUZZLE_DB_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst";

export const PUZZLE_CSV_COLUMNS = [
  "PuzzleId",
  "FEN",
  "Moves",
  "Rating",
  "RatingDeviation",
  "Popularity",
  "NbPlays",
  "Themes",
  "GameUrl",
  "OpeningTags",
  "DailyDate",
] as const;

export type PuzzleRow = {
  puzzleId: string;
  fen: string;
  moves: string[];
  rating: number;
  ratingDeviation: number;
  popularity: number;
  nbPlays: number;
  themes: string[];
  gameUrl: string;
  openingTags: string[];
  dailyDate: string;
};

export class StreamError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "StreamError";
  }
}

// A small hand-rolled CSV line splitter: RFC 4180 quoting (a quoted field may contain
// commas and newlines are not possible mid-field here since we split on '\n' first, but a
// field may still contain an escaped "" for a literal quote). The Lichess puzzle export
// itself never quotes a field in practice (no column can contain a comma), but the parser
// handles it anyway rather than assuming that forever.
export const parseCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
};

const splitWords = (raw: string): string[] => (raw.trim().length === 0 ? [] : raw.trim().split(/\s+/));

// Returns null for a malformed row (wrong arity or a non-numeric field) rather than
// throwing: one bad line in a multi-million-row file must not kill the whole stream.
export const parsePuzzleRow = (fields: readonly string[]): PuzzleRow | null => {
  if (fields.length !== PUZZLE_CSV_COLUMNS.length) return null;
  const [puzzleId, fen, movesRaw, ratingRaw, rdRaw, popRaw, nbPlaysRaw, themesRaw, gameUrl, openingRaw, dailyDate] =
    fields as [string, string, string, string, string, string, string, string, string, string, string];
  const rating = Number(ratingRaw);
  const ratingDeviation = Number(rdRaw);
  const popularity = Number(popRaw);
  const nbPlays = Number(nbPlaysRaw);
  if (![rating, ratingDeviation, popularity, nbPlays].every(Number.isFinite)) return null;
  if (!puzzleId || !fen || !movesRaw || !gameUrl) return null;
  return {
    puzzleId,
    fen,
    moves: splitWords(movesRaw),
    rating,
    ratingDeviation,
    popularity,
    nbPlays,
    themes: splitWords(themesRaw),
    gameUrl,
    openingTags: splitWords(openingRaw),
    dailyDate,
  };
};

// --- zstd decompression: injectable so tests never spawn the real binary. ---

export type ZstdStdin = { write(chunk: Uint8Array): boolean; end(): void; once(event: "drain", cb: () => void): void };
export type ZstdProcess = { stdin: ZstdStdin; stdout: AsyncIterable<Buffer | string>; kill(): void };
export type SpawnZstdLike = (zstdPath: string) => ZstdProcess;

export const defaultSpawnZstd: SpawnZstdLike = (zstdPath) => {
  const proc = spawn(zstdPath, ["-dc"], { stdio: ["pipe", "pipe", "inherit"] });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    kill: () => proc.kill(),
  };
};

// --- Reservoir sampling over an async line stream, with early close. ---

export type StreamDeps = {
  fetchFn: FetchLike;
  spawnZstd: SpawnZstdLike;
  zstdPath: string;
  log?: (message: string) => void;
};

export type StreamOptions = {
  url: string;
  reservoirSize: number;
  // Keep scanning (and reservoir-sampling) until at least this many valid rows have been
  // seen, THEN stop -- a uniform sample of the first `minScanned` rows of the file, not of
  // the whole 6M+-row database. Bounds the download to a single short-lived connection.
  minScanned: number;
  seed: string;
};

export type StreamResult = {
  reservoir: PuzzleRow[];
  rowsScanned: number;
  bytesDownloaded: number;
  malformedRows: number;
};

const asBytes = (chunk: Buffer | Uint8Array): number => chunk.byteLength;

export const streamPuzzleSample = async (deps: StreamDeps, options: StreamOptions): Promise<StreamResult> => {
  const log = deps.log ?? (() => undefined);
  const controller = new AbortController();
  const response = await deps.fetchFn(options.url, {
    headers: { "User-Agent": USER_AGENT },
    signal: controller.signal,
  });
  if (!response.ok) throw new StreamError(`Puzzle database fetch failed: HTTP ${response.status}`);
  if (!response.body) throw new StreamError("Puzzle database response had no body");

  const proc = deps.spawnZstd(deps.zstdPath);
  let bytesDownloaded = 0;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    proc.kill();
  };

  const pump = (async (): Promise<void> => {
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytesDownloaded += asBytes(chunk);
        const wroteOk = proc.stdin.write(chunk);
        if (!wroteOk) await new Promise<void>((resolve) => proc.stdin.once("drain", resolve));
      }
    } catch {
      // Aborting the fetch to close early throws from inside this loop; swallow it, the
      // caller already has everything it needs from the reservoir.
    } finally {
      try {
        proc.stdin.end();
      } catch {
        // Already closed by stop(); nothing to do.
      }
    }
  })();

  const rng = createRng(options.seed);
  const reservoir: PuzzleRow[] = [];
  let rowsScanned = 0;
  let malformedRows = 0;
  let headerSkipped = false;
  let buffer = "";

  outer: for await (const chunk of proc.stdout) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (!headerSkipped) {
        headerSkipped = true;
        newlineIndex = buffer.indexOf("\n");
        continue;
      }
      if (rawLine.length > 0) {
        const row = parsePuzzleRow(parseCsvLine(rawLine));
        if (!row) {
          malformedRows += 1;
        } else {
          rowsScanned += 1;
          if (reservoir.length < options.reservoirSize) {
            reservoir.push(row);
          } else {
            const j = Math.floor(rng() * rowsScanned);
            if (j < options.reservoirSize) reservoir[j] = row;
          }
          if (rowsScanned % 100_000 === 0) log(`  scanned ${rowsScanned} row(s)...`);
          if (rowsScanned >= options.minScanned && reservoir.length >= options.reservoirSize) {
            stop();
            break outer;
          }
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  stop();
  await pump;
  return { reservoir, rowsScanned, bytesDownloaded, malformedRows };
};
