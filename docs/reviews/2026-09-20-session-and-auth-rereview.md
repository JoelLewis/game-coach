# Session and auth security re-review — 2026-09-20

Reviewed `main` at `2a28ae3ee8bb020e94f1378c350ffa9ff7ad5f64`, offline. Every file under `apps/session/src` and the specified auth/API implementation, contracts, migrations and configuration were read. No source changes, commits, network calls or scratch directories. Only this report was written.

**Result:** Do not enable real shadow AI spending yet. Budget reservations do not enforce the advertised spend limits. The auth fixes remove the original cross-browser takeover, but concurrent verification still permits unintended email aliases, and new-account promotion is not atomic with session revocation.

Reproductions used actual helpers with in-memory SQLite. Session-class reproductions transpiled the existing code in memory and substituted a minimal DurableObject base/storage adapter; they establish application behavior, not workerd scheduling guarantees. No build or test runner was invoked because those can write files.

## Part A — session Worker findings

| ID | Severity | Title | file:line |
| --- | --- | --- | --- |
| A01 | High | Reservations do not cover retries or reserve input tokens | `apps/session/src/game-session.ts:373`, `apps/session/src/jev-transport.ts:16`, `apps/session/src/budget-gate.ts:195` |
| A02 | High | Undated credits cross daily limits; game caps expire while games remain usable | `apps/session/src/game-session.ts:370`, `apps/session/src/budget-gate.ts:49`, `apps/session/src/session-store.ts:38` |
| A03 | Medium | WebSocket work is unthrottled and superseded handlers are not fenced | `apps/session/src/game-session.ts:125`, `apps/session/src/game-session.ts:137`, `apps/session/src/game-session.ts:168` |
| A04 | Medium | Finished and abandoned games still accept new moves | `apps/session/src/game-session.ts:112`, `apps/session/src/game-session.ts:254`, `apps/session/src/game-session.ts:279` |
| A05 | Medium | Guest merges leave DO ownership and budget identity stale | `apps/session/src/game-session.ts:117`, `apps/session/src/game-session.ts:374`, `apps/web/src/lib/server/players.ts:286` |
| A06 | Medium | Flush acknowledgements can discard newer shadow results and feedback | `apps/session/src/game-session.ts:501`, `apps/session/src/session-store.ts:367`, `apps/session/src/session-store.ts:571` |
| A07 | Medium | Terminal flush failures and late shadow writes have no recovery path | `apps/session/src/game-session.ts:224`, `apps/session/src/game-session.ts:477`, `apps/session/src/game-session.ts:525` |
| A08 | Low | Usage flushes are not idempotent or crash-safe | `apps/session/src/d1-flush.ts:113`, `apps/session/src/session-store.ts:583` |
| A09 | Low | Shadow audit rows never receive their archived state hash | `apps/session/src/game-session.ts:319`, `apps/session/src/game-session.ts:427`, `apps/session/src/session-store.ts:369` |

### A01 — Reservations do not cover retries or reserve input tokens

**Wrong:** One credit is debited for `transport.judge`, but the transport retries timeout/upstream failures once. Timed-out attempts are not cancelled and can both be billed. BudgetGate checks only tokens already reported, reserves no tokens, and receives usage only for successful shadow results, after R2 work. Failed/timed-out calls and failed usage reports are not accounted for. Outstanding chunks continue spending after the token cap is reached.

**Scenario:** With real AI enabled, repeated slow responses turn 150 reserved game calls into up to 300 upstream attempts. An in-memory timeout reproduction made two upstream calls for one `judge` invocation. Separately, after reporting 49,999,999 tokens against the 50,000,000 limit, the actual BudgetGate still granted ten calls. Many games can obtain chunks before usage reports arrive; failed reports leave further reservations enabled. This is bounded by other imperfect controls, not by the configured token cap.

**Minimal fix:** Reserve a conservative input-token allowance and one call for every physical upstream attempt, including retries, before dispatch. Reconcile successful usage without refunding potentially billed timeouts. Give reservations durable IDs and make accounting retryable/idempotent. Serialize each game's chunk refill and recheck its interval after the RPC: currently concurrent tasks can all pass the interval check while waiting for a refill and overwrite the local balance, wasting reserved chunks.

### A02 — Undated credits cross daily limits; game caps expire while games remain usable

**Wrong:** `reserved_jev_calls` contains no reservation day or expiry. BudgetGate charges the reservation day's player/global counters, then prunes them on a later day. Game usage is deleted 24 hours after its first reservation, irrespective of whether the game is still usable. Neither mechanism is a lifetime game cap or a cap on the day calls actually execute.

**Scenario:** Reserve ten calls just before midnight, use one, then spend nine after midnight without charging that day's call counters. Across many games and days, retained chunks can be stockpiled; idle abandonment does not discard them, and A04 permits later use. A game can also exhaust 150 calls, remain active with periodic frames, and reserve another 150 after its usage row expires. The actual BudgetGate granted 150 again after its `created_at` was moved just past the TTL in memory.

**Minimal fix:** Persist dated reservation leases; expire/re-reserve unused credits at the UTC boundary before using them. Keep per-game consumption for the game's full usable lifetime, with a terminal tombstone before pruning. Define accounting for calls crossing midnight explicitly. Do not reclaim a counter merely because its first reservation is old.

### A03 — WebSocket work is unthrottled and superseded handlers are not fenced

**Wrong:** The only interval check is inside shadow work. There is no admission limit for live moves, opponent moves, `hello`, `set_mode`, `feedback`, invalid frames or reconnects. Every schema-valid frame updates SQLite and resets the alarm before dispatch; repeated `hello` also queries events and returns them. Oversized/bad messages receive errors indefinitely. Superseding closes old sockets but records no active generation and does not check which socket supplied a frame.

**Scenario:** One authenticated guest repeatedly sends `hello` or alternates `set_mode`, producing unbounded cumulative storage operations and responses without advancing a ply or spending a model credit. Multiple reconnects repeat D1 authentication and alarm writes. An old move handler already awaiting a template lookup can continue after its socket has been superseded; closing the socket does not cancel that handler. No cross-game write follows from this alone.

**Minimal fix:** Add bounded per-game/per-connection message and reconnect limits, including invalid messages, before storage work. Close sustained offenders. Persist an active socket generation in hibernation-safe state/attachments and reject stale frames and stale asynchronous continuations. Keep ply validation and acceptance together before external awaits. The 1,200-ply cap bounds distinct move rows, not repeated frame work.

### A04 — Finished and abandoned games still accept new moves

**Wrong:** `fetch` accepts an owned terminal game, and neither move handler checks `meta.status`. Only repeated `game_end` is treated as terminal. Shadow work also lacks a terminal-state admission check.

**Scenario:** Finish a game, reconnect using its valid owner cookie, and send a higher-ply move. It is recorded, judged and potentially sent to real shadow AI. An in-memory call to the actual handler changed a finished game's `last_ply` from 0 to 1. Additional ten-ply flushes can change a finished game's history; this also makes old reservation credits reusable after idle abandonment.

**Minimal fix:** Reject mutating frames when the durable game state is terminal, before recording or scheduling anything. Permit only explicitly supported terminal reads/feedback. Recheck terminal state when asynchronous work is admitted, while still allowing already-admitted results to finish their audit writes safely.

### A05 — Guest merges leave DO ownership and budget identity stale

**Wrong:** Auth reassigns the game's D1 owner, but GameSession retains its original `playerId`/`playerKind`. The outer Worker correctly resolves the new account, then the DO compares that ID with the old guest ID and returns HTTP 403. Shadow reservations and usage flushes continue using the original identity. BudgetGate's private counters are not the D1 `usage_daily` rows moved by auth. Open sockets are never revalidated after session deletion, logout or merge.

**Scenario:** A guest creates a game and signs into an existing account from the same browser. Its next upgrade passes outer ownership checks but fails inside the DO, without an application close code. A still-open guest socket continues submitting moves under the old guest budget. Repeating guest creation/merge into one account leaves multiple independent budget identities instead of enforcing the resolved player's daily total. Logout also leaves an existing socket usable.

**Minimal fix:** Introduce a trusted, serialized ownership transition that updates/fences the DO and migrates or aliases BudgetGate counters to the canonical player. Revoke or expire socket authorization using a session/identity generation, rather than retaining only a player ID. Preserve application close responses on authorization failures during transitions.

### A06 — Flush acknowledgements can discard newer shadow results and feedback

**Wrong:** A flush snapshots rows, awaits D1, then marks each row flushed by primary key alone. During the await, shadow completion or feedback can update the same row and set `flushed = 0`; the older acknowledgement overwrites that dirty marker. Flushes are also not serialized, so overlapping snapshots can overwrite newer D1 data or regress `last_ply`/`last_flushed_ply`.

**Scenario:** Snapshot a judgment with `shadow_status = NULL`; shadow completes and records `ok`; acknowledge the old snapshot. Reproduced with the actual store helpers: the current row was `ok, flushed=1`, while the persisted snapshot had no shadow result and `getUnflushed()` returned no judgment. The same race loses helpfulness changes. A late old D1 batch can replace a newer shadow row with the older snapshot.

**Minimal fix:** Version mutable rows, acknowledge only the exact version sent, and serialize flush execution. Use monotonic/version-checked D1 updates so stale snapshots cannot replace newer rows or lower progress.

### A07 — Terminal flush failures and late shadow writes have no recovery path

**Wrong:** Ending or abandoning first persists terminal status, then attempts a flush whose errors are swallowed. The next alarm returns immediately for terminal games; another `game_end` also returns without flushing. Shadow completion only marks rows dirty and does not schedule a flush. Initialization sets no idle alarm until a socket connects.

**Scenario:** D1 fails during `game_end`. The DO becomes finished, closes the client, and never retries the terminal D1 update; D1 can remain live indefinitely. Alternatively, a successful end flush precedes shadow completion, leaving its later results/usage only in DO storage. Finished-game RPC reads D1, so it cannot recover them. Creating a game and never connecting leaves it live without an idle alarm.

**Minimal fix:** Persist a pending finalization/flush job independent of gameplay status. Schedule bounded-backoff alarms until it commits, and schedule another flush whenever late shadow work dirties a terminal game. Acknowledge end consistently only after durable recovery responsibility exists. Arm idle cleanup during initialization. Avoid unlimited tight retries.

### A08 — Usage flushes are not idempotent or crash-safe

**Wrong:** Moves/judgments/events use keyed replacement, but `usage_daily` adds each submitted delta again. Pending usage is zeroed before awaiting D1 and exists only in a local variable until acknowledgement or catch.

**Scenario:** Replaying the identical actual `flushToD1` input twice produced two calls/200 tokens for a one-call/100-token delta. A commit with a lost acknowledgement can therefore double-count on retry. Termination after the DO resets pending usage but before D1 commits loses that delta. Daily attribution uses flush time, not call time. These affect audit accounting; BudgetGate uses separate counters.

**Minimal fix:** Persist an outbox entry with a unique flush/usage ID and its accounting day before sending. Deduplicate that ID in the same D1 transaction as its delta, then durably acknowledge it. Do not rely on an in-memory snapshot to restore accounting.

### A09 — Shadow audit rows never receive their archived state hash

**Wrong:** The live judgment stores `stateHash: ""`; shadow completion writes answers/decision/usage but never the computed `result.stateHash`. The R2 object is written under that hash, leaving no judgment-to-artifact reference. Model/transport remain the live sentinels too.

**Scenario:** Calibration reads a shadow judgment but cannot locate its exact archived state from the row. The SHA-256 R2 key itself is safe; the audit linkage is missing.

**Minimal fix:** Persist the shadow state's hash and actual model/transport alongside the shadow result, without changing the live decision fields, and include them in versioned flushes.

## Part B — status of the previous 13 findings

| ID | Status | Current evidence and assessment |
| --- | --- | --- |
| F01 | Partially fixed | `apps/web/src/lib/server/players.ts:323` requires the verifying browser's guest to match the token hint; a different-browser verification no longer promotes the requester. Revocation exists at `:275`, but new-account promotion precedes it (`:386`, `:401`): B02. Already-open sockets also survive revocation: A05. |
| F02 | Partially fixed | Terminal resolution fails closed at `players.ts:75`; sequential sibling invalidation and guarded ordinary merges are present at `:275`, `:282`. Concurrent new-email verifications still alias an already-promoted account at `:390`: B01. The lost-race fallback at `:419` can also update an account-kind candidate without proving this operation created it. |
| F03 | Partially fixed | `apps/web/src/hooks.server.ts:88` no longer mints guests. Both POST handlers validate media type/body and apply the IP limiter before `ensureGuestPlayer` (`apps/web/src/routes/auth/request/+server.ts:28`, `:47`; `apps/web/src/routes/api/games/+server.ts:17`, `:33`). Refresh writes are reduced at `players.ts:128`. Missing-binding admission, distributed churn and absent player/game retention remain: B03/A07. |
| F04 | Fixed | `apps/web/src/hooks.server.ts:50`, `:55` validate required configuration and check Origin before identity access; `apps/web/src/lib/server/origin.ts:8` covers POST/PUT/PATCH/DELETE regardless of Content-Type. Missing/null/foreign origins fail with the shipped origin. |
| F05 | Partially fixed | `apps/web/src/routes/auth/verify/+server.ts:22` only consumes on POST; `+page.svelte:25` requires a click. GET/HEAD scanners no longer consume tokens. Confirmation does not identify the destination account or bind confirmation to browser state: B04. |
| F06 | Partially fixed | `players.ts:191` atomically checks both issuance counts in INSERT; consumed/failed-delivery tokens still count. Recipient lockout remains explicitly acknowledged at `:26`: five requests per 15 minutes exhaust a known email's quota, well below the configured 30/minute IP limit. Provider aliases remain independent keys. Add a challenged recipient recovery path and separate abuse keys without changing account identity normalization. |
| F07 | Partially fixed | `apps/web/src/routes/auth/request/+server.ts:56` removes awaited delivery and catches rejection with a sanitized message; successful/throttled issuance returns the same 202. Delivery is still nondurable `waitUntil`, with no retry/outbox, and failures occupy the recipient quota. Five failed sends can suppress later requests after email service recovers. Persist delivery work and retry with bounded policy; exact timing equality is not established. |
| F08 | Partially fixed | Atomic consumption remains at `players.ts:218`; existing-account merge/revocation/session creation share a batch at `:361`. The email-unclaimed predicate at `:379` correctly keeps a losing guest mergeable in the two-guests/one-email race. However, new-account creation and finalization are separate batches (`:386`, `:401`), and stale guest eligibility is insufficient: B01/B02. The accepted consume-first deviation is not the only transaction split. |
| F09 | Fixed | Links use fragments (`apps/web/src/routes/auth/request/+server.ts:51`), verification sends JSON (`apps/web/src/routes/auth/verify/+page.svelte:32`), auth responses use no-store/no-referrer (`apps/web/src/lib/server/security-headers.ts:29`), and web observability redacts queries (`apps/web/wrangler.jsonc:10`). Deployed logging was not inspected. |
| F10 | Fixed | `apps/web/vite.config.ts:28` supplies SvelteKit-managed CSP in auto mode; `apps/web/src/lib/server/security-headers.ts:20` no longer overwrites it. Installed SvelteKit generates the nonce/hash source and matching bootstrap authorization. No unrestricted inline-script permission was added. |
| F11 | Partially fixed | Hook errors receive baseline headers (`apps/web/src/hooks.server.ts:102`); static responses gain X-Frame-Options DENY (`apps/web/_headers:12`). Installed `@sveltejs/kit/src/runtime/server/respond.js:81` still returns form-CSRF 403 before hooks, and the hook's own 403/500/503 responses have no CSP/frame denial (`hooks.server.ts:25`, `:108`). `_headers` still has no general static HTML CSP. Apply baseline policy at the outer response boundary; preserve generated page CSP. |
| F12 | Fixed | `apps/web/src/lib/server/config.ts:13` rejects missing/short secrets and empty origins before identity access (`apps/web/src/hooks.server.ts:50`). Session Worker also rejects short secrets (`apps/session/src/auth.ts:45`). Config validates length, not entropy or URL syntax; actual shared-secret equality was not inspected. |
| F13 | Partially fixed | `db/migrations/0002_auth_hardening.sql:7` supplies the missing guest/expiry index. Opportunistic cleanup exists at `players.ts:233`, but its expiry-only queries scan both tables, and player/game retention is absent: B05/B03. |

### B01 — High: Concurrent verifications can attach another email to an account

**Evidence:** `apps/web/src/lib/server/players.ts:323`, `:379`, `:390`, `:419`.

**Wrong:** Eligibility is read before the mutation. The subsequent accounts INSERT requires only that the candidate is now `kind='account'`; it does not prove this operation successfully promoted the guest. Invalidating sibling tokens does not stop siblings already consumed and in flight.

**Scenario:** Two tokens for different new emails name the same guest, and both verification requests present its live cookie and pass eligibility before either promotion commits. Request A promotes it for email A. B's promotion affects zero rows, but B still inserts email B against the now-account player. Reproduced with two genuinely issued/consumed tokens and a barrier before the existing mutation batches: both completed and both email rows referenced the same player. A holder of a copied/shared guest cookie and their own email token can race the guest owner's verification to retain an alternate login. The original attack requiring only a link request from a different browser is fixed; this requires shared guest-session access and overlapping verification.

**Minimal fix:** Serialize/claim the source guest transition durably and make account insertion conditional on that operation's successful claim, not on its resulting kind. Consume/finalize sibling operations against a transition generation. Never use the generic lost-race account merge for an eligible guest that another operation already promoted.

### B02 — High: Promotion commits before revocation and session issuance

**Evidence:** `apps/web/src/lib/server/players.ts:386`, `:397`, `:401`; `apps/web/src/routes/auth/verify/+server.ts:39`.

**Wrong:** The first batch promotes/creates the account; a later read and second batch revoke sessions/sibling tokens and issue the new session. This contradicts the claimed single guarded identity-transition batch, independently of the accepted separate token-consumption statement.

**Scenario:** Fail after the first batch. The token is spent, the guest is an account, old guest sessions still resolve to that account, and sibling tokens remain live. Reproduced by throwing after the actual account-creation batch: `resolveSession` on the old guest cookie returned `playerKind: 'account'`. Even without failure, a concurrent request can observe this window; an existing socket extends that exposure under A05.

**Minimal fix:** Put promotion/account assignment, source revocation, sibling invalidation and new session issuance in one transaction, with a durable transition claim resolving races. The consume-first deviation can fail closed by burning a token before an otherwise atomic transition, though it needs a defined retry/reissue policy; it does not justify committing a privilege change before revocation.

### B03 — Medium: Missing limiter silently removes guest admission protection

**Evidence:** `apps/web/src/lib/server/rate-limit.ts:18`, `apps/web/src/lib/server/config.ts:13`, `apps/web/wrangler.jsonc:29`, `apps/session/src/budget-gate.ts:167`.

**Wrong:** An absent RATE_LIMITER returns “allowed” in every environment, without an explicit development guard. Config validation does not require it. Even when present, the only guest admission control is per-IP; there is no global game/identity admission counter, challenge, or player/game retention.

**Scenario:** A preview/alternate deployment with DB, auth config and SESSION but no limiter accepts unlimited cookie-discarding valid create-game requests. Each creates a player/session/game/DO and resets the per-player game allowance. In the shipped deployment, distributed IPs or sustained traffic below 30/minute still accumulate these records. Global model counters do not cap these storage writes, and unopened games have no alarm (A07).

**Minimal fix:** Require the binding in deployed environments; allow bypass only through explicit local configuration. Add a global admission/storage budget and retention for abandoned guests/games, with stronger admission before real spend. Preserve the now-correct ordering of validation/rate checks before guest minting.

### B04 — Medium: Confirmation hides which account will be signed in

**Evidence:** `apps/web/src/routes/auth/verify/+page.svelte:54`, `apps/web/src/routes/auth/verify/+server.ts:39`.

**Wrong:** The page offers only “Confirm sign-in,” without showing the token's destination identity. There is no browser-bound confirmation state. A valid token can switch the current browser to any corresponding account after this generic click.

**Scenario:** An attacker sends their own magic link to another person, describing it as an app sign-in. The recipient sees no attacker email and confirms; subsequent game history belongs to the attacker. Unlike the previous implementation, navigation alone no longer suffices.

**Minimal fix:** Resolve the destination without consuming the token, show it clearly, and require an explicit confirmation bound to that token and browser. Warn explicitly when switching an existing signed-in identity. Keep GET/HEAD non-consuming and preserve fragment transport.

### B05 — Low: “Bounded” cleanup limits deletions, not database scanning

**Evidence:** `apps/web/src/lib/server/players.ts:233`, `apps/web/src/routes/auth/request/+server.ts:63`, `db/migrations/0002_auth_hardening.sql:7`.

**Wrong:** Cleanup filters only by `expires_at`, but the relevant indexes start with email/guest/player, or are primary keys. `LIMIT 50` bounds deletions, not rows examined. Cleanup runs probabilistically only on auth requests and does not remove guest player rows.

**Scenario:** With many unexpired sessions/tokens and few expired rows, cleanup scans large tables while finding little to delete. Actual SQLite EXPLAIN returned `SCAN magic_link_tokens` and `SCAN sessions`. An auth-request workload or accumulated game-created sessions amplifies cleanup work even after the original per-guest COUNT index fix.

**Minimal fix:** Add expiry-leading indexes and scheduled, bounded retention work. Include orphan guest retention and handle foreign-key/history ownership deliberately; do not rely solely on probabilistic auth traffic.

### B06 — Medium: HTTP JSON bodies are parsed before any application byte cap

**Evidence:** `apps/web/src/routes/auth/request/+server.ts:36`, `apps/web/src/routes/auth/verify/+server.ts:28`, `apps/web/src/routes/api/games/+server.ts:25`.

**Wrong:** Schema field limits apply after `request.json()` allocates/parses the whole body. None of these handlers enforces a total input byte limit; verify also has no IP limiter. Unknown fields can make an otherwise small request arbitrarily large within platform limits.

**Scenario:** Send large JSON bodies containing a small valid token/email/config plus an enormous unused field, or repeated large malformed bodies to verification. They consume parsing/memory work before rejection; the 2,048-character token cap is not a request-size cap. No account or valid token is needed to reach verification parsing from a non-browser client supplying the expected Origin.

**Minimal fix:** Enforce a small streamed byte limit before JSON parsing, independent of Content-Length, and apply appropriate verification admission limits. Retain schema validation afterwards.

## Verified OK

- **Outer WS trust boundary:** Origin, HMAC, unexpired D1 session and resolved ownership are checked before `idFromName(gameId)` (`apps/session/src/auth.ts:116`, `apps/session/src/index.ts:22`). Arbitrary nonexistent IDs cause bounded D1 lookups, not new GameSession allocation. Known auth failures complete the handshake and close with application codes. Uncaught D1/infrastructure errors are not converted to that close protocol.
- **Header/RPC boundary:** `Headers.set` overwrites the case-insensitive trusted player header (`apps/session/src/index.ts:28`). No client-selectable identity reaches the DO through this route. The named WorkerEntrypoint and DO methods have no public HTTP RPC dispatcher here; they trust holders of their bindings. Web create/read routes derive player IDs from verified locals/guest creation, not request JSON.
- **Cookies and Origin:** Both Workers verify the HMAC over the raw session bytes and hash those bytes for lookup. Permissive base64 spellings do not forge a MAC. Session's parser takes the first matching cookie and lacks web's 32-byte ID check, but no bypass follows without a valid signature and matching row. Production Origin uses exact equality. The localhost exception activates only when configured APP_ORIGIN begins `http://localhost`; tighten this to a parsed hostname for development, but it is inactive in shipped production config.
- **Ownership resolution:** Both merge resolvers terminate with a real terminal player or fail closed. `getGameSummary`/`getGameState` check resolved ownership before DO state or D1 history reads (`apps/session/src/entrypoint.ts:119`, `:150`). Foreign existing IDs return forbidden, nonexistent IDs return not-found: an existence distinction, not history disclosure. IDs are generated UUIDs.
- **Input shape and storage scope:** WS frames have a 16,384-byte pre-JSON cap and Valibot validation. Ply fields are bounded to 1,200, notation/positions/lines are length-bounded, and feedback only touches the current DO. Eval/swing/clock integers lack safe-range maxima, but they do not control allocation/loops here; the frame cap bounds feature input. Engine legality/evaluation truth is intentionally not verified server-side. Sequential ply checks reject replay; asynchronous fencing limitations are covered above.
- **Live/shadow separation:** The live judgment calls code/templates only. Shadow is scheduled after player frames, updates only shadow columns, and has an outer catch plus a guarded failure-status write (`apps/session/src/game-session.ts:341`, `:445`). A denied reservation returns before model dispatch. No writer model is called. Retry count is finite (one), not an unbounded retry loop.
- **BudgetGate concurrency:** After awaiting config, reservation reads/checks/counter writes are synchronous SQL with no external await between them. The code has no ordinary read-await-write race within the global reservation critical section. Persisted DO balances survive hibernation; the defects concern attempt accounting, leases, identity and lifetime, not a purely in-memory counter reset.
- **SQL/R2:** Reviewed SQL uses bound client values. Each D1 flush submits one batch, providing transaction-level atomicity; A06–A08 concern coordination/idempotency across that boundary. R2 state keys derive from a server-computed SHA-256, not a client-supplied path (`judge-jev-shadow.ts:140`, `game-session.ts:535`). No game-record upload path is implemented here.
- **Fragment page and CSP:** The token is kept in component memory, used only in JSON POST, and removed from the current URL with `history.replaceState` after client startup (`apps/web/src/routes/auth/verify/+page.svelte:18`). No `{@html}`, innerHTML, dynamic code execution or token-derived navigation sink appears. Fragments are not sent in HTTP requests/referrers; pre-hydration browser history/extension exposure is not eliminated. Production CSP permits same-origin scripts plus generated nonces/hashes and WASM compilation; it permits inline styles, data images, and same-origin/blob workers, but not arbitrary inline JS or JS eval. Adapter code copies the root `_headers`; its absence under `static/` is not a defect.
- **Session refresh/state endpoint:** Refresh updates existing rows only after half-life and cannot recreate a deleted session (`players.ts:120`). Cookie Max-Age is renewed more often than D1 expiry, so an idle returning browser may retain a cookie whose row expired; server-side expiry still rejects it. GET state does not mint guests, uses resolved ownership and returns no-store (`apps/web/src/routes/api/games/[id]/state/+server.ts:13`). Move/judgment result counts are bounded by persisted distinct plies; recent events are capped at 20. Finished reads come from D1, subject to the flush defects.
- **Shipped configuration/logging:** Session ships `JEV_MODE=off` and fixture transport; neither spends AI credits. No literal secrets or deliberate cookie/token logging were found. Web query redaction is configured; session observability has no matching redaction, but its normal WS URL carries only a game ID. Error logging includes some raw exception messages, so production/provider log contents are not proven secret-free.

## Not reviewed / could not verify

- No deployment, browser, real AI/email, network, workerd integration or production D1 tests. In-memory interleavings are controlled application-level reproductions; exact supersede/event scheduling and crash recovery need workerd tests. Existing tests were inspected selectively, not run, and are not evidence that these cases pass.
- Actual secrets, runtime bindings, service-binding access outside this repository, account-wide WAF/quotas, platform request-size limits, deployed CSP/asset headers, log sinks/redaction and external retention jobs were not inspected. Public HTTP cannot call the named RPC methods through this code; a separately provisioned trusted binding can supply arbitrary player IDs.
- Adjacent Jev retry/Workers AI transport, request-size estimation and installed SvelteKit CSP/CSRF/adapter code were read where needed. This was not a full review of coaching-core, browser chess/WASM, calibration tools, dependency vulnerabilities or infrastructure permissions.
- The report's spend findings apply when both shadow mode and real Workers AI transport are enabled. The shipped off/fixture defaults prevent that model spend today; they do not repair the latent budget defects.
