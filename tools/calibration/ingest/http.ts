// Shared, injectable HTTP plumbing for the two public-API fetchers (lichess.ts,
// chesscom.ts): a descriptive User-Agent and polite backoff on 429. Network code takes
// an injected `fetch` so tests run entirely on fixtures.
export const USER_AGENT = "GameCoachCalibrationIngest/0.1 (+contact: joel.e.lewis@gmail.com)";

export class HttpFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "HttpFetchError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

export const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRIES = 5;

// One request in flight at a time (callers never call this concurrently for the same
// source), a descriptive User-Agent, and exponential backoff honouring `retry-after`.
export const fetchWithBackoff = async (
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  sleep: SleepLike = defaultSleep,
): Promise<Response> => {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const response = await fetchFn(url, init);
    if (response.status !== 429) return response;
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter && !Number.isNaN(Number(retryAfter)) ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt;
    await sleep(waitMs);
  }
  throw new HttpFetchError(`Rate limited after ${MAX_RETRIES} retries: ${url}`);
};
