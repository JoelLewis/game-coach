# Identity security review — 2026-09-18

Reviewed `main` at `d6c878caa832d29ae52bc3c2eeafbb26a3eec1a6`, offline. No source changes or commits. Reproductions used the actual identity helpers and migration through the existing in-memory SQLite adapter; these establish application defects, not production D1 integration results.

| ID | Severity | Title | file:line |
| --- | --- | --- | --- |
| F01 | Critical | Requesting guest retains access to the victim's account | `apps/web/src/routes/auth/verify/+server.ts:27`, `apps/web/src/lib/server/players.ts:54`, `apps/web/src/lib/server/players.ts:80` |
| F02 | Critical | Pending links can attach attacker emails to accounts; unrestricted merges create cycles | `apps/web/src/lib/server/players.ts:160`, `apps/web/src/lib/server/players.ts:165`, `apps/web/src/lib/server/players.ts:191` |
| F03 | High | Unrestricted guest creation defeats identity-based abuse controls | `apps/web/src/hooks.server.ts:19`, `apps/web/src/hooks.server.ts:73`, `apps/web/src/lib/server/players.ts:22` |
| F04 | Medium | Origin enforcement can be bypassed by omitting Content-Type | `apps/web/src/lib/server/origin.ts:16`, `apps/web/src/hooks.server.ts:35`, `apps/web/src/routes/api/games/+server.ts:14` |
| F05 | Medium | Magic-link GET permits login CSRF and scanner consumption | `apps/web/src/routes/auth/verify/+server.ts:11`, `apps/web/src/routes/auth/verify/+server.ts:20`, `apps/web/src/routes/auth/verify/+server.ts:38` |
| F06 | Medium | Link limits race, reset on consumption, and allow victim lockout | `apps/web/src/lib/server/players.ts:87`, `apps/web/src/lib/server/players.ts:111`, `apps/web/src/lib/server/players.ts:123` |
| F07 | Medium | Email delivery exposes throttling and breaks the uniform response on failure | `apps/web/src/routes/auth/request/+server.ts:32`, `apps/web/src/routes/auth/request/+server.ts:36` |
| F08 | Medium | Verification is not atomic across consumption, account changes, and rotation | `apps/web/src/routes/auth/verify/+server.ts:20`, `apps/web/src/routes/auth/verify/+server.ts:28`, `apps/web/src/routes/auth/verify/+server.ts:38`, `apps/web/src/lib/server/players.ts:161` |
| F09 | Medium | Observability retains bearer tokens in request query strings | `apps/web/wrangler.jsonc:8`, `apps/web/src/routes/auth/request/+server.ts:33` |
| F10 | Medium | CSP blocks SvelteKit's client startup script | `apps/web/src/lib/server/security-headers.ts:8`, `apps/web/src/lib/server/security-headers.ts:29` |
| F11 | Low | Security headers do not cover every response; static CSP is absent | `apps/web/_headers:4`, `apps/web/src/hooks.server.ts:90` |
| F12 | Medium | Missing session secret fails after database writes | `apps/web/src/lib/server/cookie.ts:12`, `apps/web/src/hooks.server.ts:48`, `apps/web/src/hooks.server.ts:74` |
| F13 | Low | Per-player throttling scans an indefinitely growing token table | `apps/web/src/lib/server/players.ts:96`, `db/migrations/0001_init.sql:97` |

## F01 — Requesting guest retains access to the victim's account

**Wrong:** Verification promotes/merges the player recorded in the token, but rotation deletes only the session presented by the browser opening the link. Other sessions for the requesting guest survive. `resolveSession()` follows `merged_into` and grants the destination account identity; promotion grants account identity directly.

**Exploit:** An attacker obtains guest cookie G and requests a link for the victim's email. The victim opens the legitimate email on their own browser. Verification rotates the victim browser's session, while G now resolves to the victim's account. The attacker never needs to see the token. This was reproduced with the actual helpers: the retained requester session resolved to the victim's player with kind `account`.

**Minimal fix:** Atomically revoke every session belonging to the source guest when promoting/merging, then issue an authenticated session only to the verifying browser. Prevent outstanding requests from minting sessions for a source whose identity transition has already occurred. Address pending tokens separately as in F02.

## F02 — Pending links can attach attacker emails to accounts; unrestricted merges create cycles

**Wrong:** `upgradeOrMerge()` never verifies that the source is still an unmerged guest. A new email is attached to the supplied player even when it already owns an account or is merged. Existing-account paths can merge accounts into accounts, overwrite a previous destination, and target players that are themselves merged. `resolveSession()` returns a player after five hops even when the chain has not terminated (`players.ts:54–59`).

**Exploit:** From G, request links for both the victim and an attacker-controlled email. After the victim verifies, consume the attacker's still-pending link. It adds the attacker's email to the victim's player, giving a durable alternate login. Reproduced even after deleting G's original session. Separately, merging A into B and then B into A produced a cycle; subsequent resolution depends on the starting player and hop limit. Ordinary account switching can therefore transfer games or corrupt ownership as well.

**Minimal fix:** Require a conditional, atomic transition from `kind='guest' AND merged_into IS NULL`; invalidate sibling pending links on transition. An account sign-in must not promote, alias, or merge an already-account source. Resolve and validate a terminal destination before transferring ownership, and reject cycles/unresolved chains. Account linking needs its own explicitly authorized flow.

## F03 — Unrestricted guest creation defeats identity-based abuse controls

**Wrong:** Any cookie-less dynamic GET advertising `Accept: text/html`, and every non-GET passing the limited Origin checks, inserts a player and session before route validation. This includes invalid routes, malformed requests, HEAD, and OPTIONS. There is no admission limit or challenge. A resolved session also causes a D1 expiry UPDATE on every dynamic request (`hooks.server.ts:66`).

**Exploit:** Repeatedly GET a dynamic path with HTML Accept and discard cookies. Each request performs a transactional batch with two INSERTs, random generation, hashing, and HMAC signing. A bot can inflate D1 indefinitely and obtain arbitrarily many player IDs. A budget keyed only by player can then be reset by replacing the cookie. Actual AI spending is not reproducible here because the session/BudgetGate implementation is still a stub.

**Minimal fix:** Apply edge/IP and global admission controls before database writes, with a challenge or equivalent stronger control before granting spend. Mint guests only on an intentional bootstrap path; reject invalid methods/routes first. Retain global spend caps independent of guest identity and expire abandoned identities.

## F04 — Origin enforcement can be bypassed by omitting Content-Type

**Wrong:** The custom check only covers content types beginning with `application/json`. The handlers call `request.json()` without requiring that content type, and logout requires no body. SvelteKit's default CSRF protection covers its recognized form content types, not requests without Content-Type. Missing/empty APP_ORIGIN also skips the custom guard entirely.

**Exploit:** JavaScript on an attacker-controlled HTTPS sibling subdomain sends a credentialed POST with a `Uint8Array` containing JSON and no Content-Type. This is a simple cross-origin request; SameSite=Lax permits cookies between these same-site subdomains. Both CSRF checks miss it, allowing link requests, game creation once implemented, or logout. CORS prevents reading the response, not the mutation. The helper accepted a foreign Origin with missing Content-Type in reproduction.

**Minimal fix:** Require exact APP_ORIGIN for all POST/PUT/PATCH/DELETE requests, independently of content type; reject missing and `null` origins. Validate APP_ORIGIN as required configuration and separately enforce accepted request media types.

## F05 — Magic-link GET permits login CSRF and scanner consumption

**Wrong:** Navigating to a bearer link immediately changes the browser's identity without checking user intent or a requesting-browser nonce. GET bypasses the state-changing Origin guard; SvelteKit also permits HEAD to invoke a GET handler when no HEAD handler exists.

**Exploit:** An attacker requests a link to their own inbox and induces a victim to navigate to it. The victim is silently signed into the attacker's account and may create private game history there. Email security scanners opening GET/HEAD links can also consume a link before its owner clicks it. This is separate from F01: the attacker supplies their own token here.

**Minimal fix:** Make GET/HEAD non-consuming. Display the destination identity and require an explicit same-origin POST confirmation, protected by browser-bound state. For cross-device sign-in, require confirmation instead of silently switching identity.

## F06 — Link limits race, reset on consumption, and allow victim lockout

**Wrong:** Counts and INSERT are separate operations. Only unused, unexpired tokens count, so this limits outstanding links rather than requests per time window. Lowercasing/trim handles case and whitespace, but provider-equivalent plus/dot aliases remain independent keys; new guests reset the player dimension.

**Exploit:** Twelve concurrent calls for one player/email all issued tokens against the nominal limit of three in the in-memory reproduction. A mailbox owner can consume links and immediately request more. An attacker can also fill a victim's three slots and refill after expiry, causing the victim's own requests to return success without sending their requested link. Plus aliases multiply delivery to providers supporting them. The installed email validator rejects Unicode addresses, so a Unicode-equivalence bypass was not established.

**Minimal fix:** Atomically reserve issuance against time-window counters that include consumed and failed deliveries. Add independent requester/IP/global limits. Use carefully scoped provider-aware abuse keys where appropriate, without universally stripping plus/dot characters from account identity. Avoid letting unauthenticated traffic monopolize a recipient's recovery capacity; preserve a challenged recovery path.

## F07 — Email delivery exposes throttling and breaks the uniform response on failure

**Wrong:** Accepted issuance awaits EMAIL.send; throttled requests skip it. Delivery rejection escapes as an error instead of the promised 202. The token is already stored and occupies a throttle slot when sending fails.

**Exploit:** Repeated timing measurements distinguish the throttled path from the delivery path, revealing recent request activity. An email-service outage makes fresh requests fail while already-throttled requests still succeed; repeated failed sends can exhaust a recipient's slots. This is an activity/delivery oracle, not a demonstrated account-existence oracle: the code does not query accounts and sends to both new and existing emails.

**Minimal fix:** Use durable queued delivery with a uniform acknowledgement independent of send outcome, retries, and sanitized operational errors. Make throttled and accepted handling comparable in observable timing; account for delivery failure explicitly without exposing it to the requester.

## F08 — Verification is not atomic across consumption, account changes, and rotation

**Wrong:** Token consumption, promotion/merge, and rotation are three separate commits. The account-existence lookup is also outside the mutation batch. D1 batch atomicity protects each individual batch, not the entire workflow.

**Failure:** Two guests verify distinct links for the same new email concurrently. Both can read no account; one INSERT wins and the other fails the unique constraint after its token has been consumed. This race was reproduced. A database failure between merging and rotation likewise leaves changed ownership with no successful login. A cookie-less verification GET lacking HTML Accept consumes the token and changes the account before failing `missing session` (`verify/+server.ts:35`).

**Minimal fix:** Validate prerequisites before mutation. Serialize or redesign the flow as conditional statements in one D1 transactional batch covering consume, identity transition, revocation, and new session insertion. Handle concurrent account creation by safely selecting the winning account rather than burning the losing token. Preserve single-use semantics under retries.

## F09 — Observability retains bearer tokens in request query strings

**Wrong:** Magic links carry tokens in the query string while Wrangler enables observability without redaction. The installed Wrangler defaults enable persisted invocation logs at full sampling and set `redact_query_string: false`; its schema explicitly identifies this setting as request-URL query removal for logs/traces. Avoiding application `console.log` is insufficient.

**Failure:** A verification request records the credential in infrastructure telemetry. If processing fails before consumption, that recorded token can remain usable until expiry; successful requests still violate the no-token-logging guarantee. Production log access and retention were not inspected.

**Minimal fix:** Set observability query-string redaction and verify it in deployed logs; disable URL-bearing invocation logging until that guarantee holds. Apply `Referrer-Policy: no-referrer` and `Cache-Control: no-store` to auth responses. The current referrer policy permits full URLs on same-origin referrals (`security-headers.ts:24`), so it does not independently guarantee token confidentiality on rendered verification-error paths.

## F10 — CSP blocks SvelteKit's client startup script

**Wrong:** `script-src 'self' 'wasm-unsafe-eval'` permits same-origin script files and WASM compilation, but not inline JavaScript. The installed SvelteKit renderer emits an inline bootstrap script. No CSP nonce/hash configuration appears in `apps/web/vite.config.ts:9`, and the hook overwrites Content-Security-Policy unconditionally.

**Failure:** Production HTML renders, but the browser blocks hydration/client startup, preventing interactive flows. This follows from the installed renderer's script generation; no production browser run was performed.

**Minimal fix:** Configure SvelteKit's CSP generation with nonces/hashes for its generated scripts, retain the existing WASM/worker restrictions, and stop replacing the generated policy with a static header. Do not solve this with unrestricted inline JavaScript.

## F11 — Security headers do not cover every response; static CSP is absent

**Wrong:** `_headers` includes COOP/COEP, nosniff, and referrer policy, but no CSP/frame-ancestors. The hook decorates only responses it reaches successfully. SvelteKit's built-in form-CSRF rejection occurs before the hook; exceptions during identity/database processing are handled outside it. These responses miss the promised headers.

**Failure:** A cross-origin form POST receives an undecorated 403. A D1 failure in the hook produces an undecorated error response. Static/prerendered HTML served using only `_headers` lacks the dynamic policy's clickjacking protection; no currently exposed sensitive static HTML page was established.

**Minimal fix:** Apply baseline headers at the outer Worker response boundary, including errors and framework early returns, and supply an appropriate CSP for static HTML. Test dynamic successes, redirects, errors, CSRF rejections, and static documents.

## F12 — Missing session secret fails after database writes

**Wrong:** The secret is not validated before use. Both empty and undefined values produce an empty encoded key and a Web Crypto import error in the local runtime. Guest creation commits before signing, and the exception bypasses the hook's header application.

**Failure:** Deploy without SESSION_SECRET: each cookie-less HTML request inserts another guest/session pair and then returns an error. Existing correctly shaped cookies also cause verification errors. Local checks returned `DataError: Zero-length key is not supported` for both cases; this is availability/storage failure, not a demonstrated empty-key authentication bypass.

**Minimal fix:** Validate a nonempty, high-entropy secret and required origin configuration before any identity read/write; return a controlled unavailable response with security headers on misconfiguration. Confirm both Workers use the same secret.

## F13 — Per-player throttling scans an indefinitely growing token table

**Wrong:** The per-player COUNT filters on guest_player_id, but the migration indexes only token_hash and email/expires_at. SQLite EXPLAIN confirmed `SCAN magic_link_tokens`. The reviewed implementation never purges expired/used tokens, and merge operations also have no bound on source history size (`players.ts:178–190`).

**Exploit:** Repeated requests across disposable guests/emails grow the token table; every subsequent link request scans it, including requests later rejected by the email limit. This amplifies F03 into increasing database work and availability risk.

**Minimal fix:** Add an index supporting the per-player live-token query, enforce retention cleanup and admission limits, and use indexed bounded time-window counters. Bound or explicitly manage large-history migrations without sacrificing atomic ownership changes.

## Verified OK

- Cookie IDs and magic-link tokens use 32 cryptographically random bytes. Only SHA-256 hashes are persisted. HMAC-SHA256 is verified with Web Crypto before session lookup; malformed envelope/base64 and wrong ID length are rejected (`cookie.ts:26`, `players.ts:19`, `players.ts:119`). Permissive base64 spellings do not bypass the signature or token hash.
- Cookies explicitly set HttpOnly, SameSite=Lax, Path=/, and a 90-day Max-Age. The installed SvelteKit cookie implementation defaults Secure on outside HTTP localhost. Session expiry is checked; successful logout deletes the current session row (`hooks.server.ts:67`, `players.ts:46`, `auth/logout/+server.ts:18`). Cross-browser promotion revocation remains broken as F01 describes.
- Token consumption is one conditional UPDATE RETURNING with `used_at IS NULL` and `expires_at > now`. Twelve concurrent local consumption attempts produced one success; expiry equality is rejected. TTL is 15 minutes (`players.ts:122`, `players.ts:144`).
- SQL values are bound; no attacker-built SQL was found. Individual promotion, merge, and rotation batches are transactional in the intended D1 model. Merge adds usage counters and moves games together (`players.ts:177`).
- Successful auth/request responses have the same 202 body for new, existing, and throttled addresses. No account lookup branches on existence. Email validation rejects header control characters; the subject/from are not user-controlled, and the HTML URL is escaped (`auth/request/+server.ts:10`, `magic-link-email.ts:5`).
- Verify redirects only to literal `/` or `/auth/expired`; no open redirect or explicit token logging was found. Returned application error strings do not include tokens.
- JSON Origin checks use exact equality and cover POST/PUT/PATCH/DELETE, rejecting missing, `null`, and sibling origins when APP_ORIGIN is configured. SvelteKit's default form-CSRF protection is not disabled; no permissive CORS headers were found. F04 covers the media-type gap.
- Dynamic CSP blocks framing, objects, foreign scripts, and JavaScript eval; allows WASM and same-origin workers; allows inline styles and data images. COEP require-corp does not inherently block same-origin resources. F10/F11 limit the overall header guarantee.
- GameConfig is validated against the shared schema; playerId comes from locals, never the request body. Cookie-less non-HTML game-summary GETs pass an empty playerId to RPC (`api/games/+server.ts:19`, `api/games/[id]/+server.ts:12`). This is not proof of downstream authorization.

## Not reviewed / could not verify

- The session Worker is a skeleton: createGame/getGameSummary always return not_found and WebSocket/BudgetGate handlers return 501 (`apps/session/src/index.ts:19`, `:27`, `:31`). Shared-cookie verification, ownership enforcement, empty-player rejection, live-game behavior during merges/logout, and AI caps cannot be verified. The web mapping distinguishes forbidden (403) from not_found (404), which would expose existence if the eventual RPC distinguishes them (`session-rpc-client.ts:14`); no current existence oracle was demonstrated.
- No network, deployment, real email, production D1, or browser tests were run. D1 consume reasoning relies on a single conditional write; batch behavior was reproduced with the repository's transactional SQLite adapter, not Cloudflare concurrency/replica integration.
- Actual secrets, email-domain onboarding, edge/WAF rules, cleanup jobs outside this scope, logging sinks, deployed asset headers, Stockfish loading, and infrastructure URL redaction were not inspected. Wrangler routes remain commented out; `send_email.remote: true` allows real email use in connected local development (`wrangler.jsonc:11`, `:31`).
- Test runners/builds/type generation were deliberately not run because they can create files. Only this report was written.
