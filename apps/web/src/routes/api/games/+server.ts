// POST a GameConfig -> creates a game via the SESSION service binding (apps/session owns the
// Durable Object and D1 writes for games/moves/judgments). This is the other place a guest
// identity is minted (F03, alongside POST /auth/request), behind an IP rate limit in front of
// any D1 write.
import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { GameConfigSchema } from "@game-coach/contracts/session-rpc";
import { ensureGuestPlayer } from "../../../lib/server/guest-session.ts";
import { readJsonBody } from "../../../lib/server/http-body.ts";
import { isJsonContentType } from "../../../lib/server/origin.ts";
import { GuestMintCapExceededError } from "../../../lib/server/players.ts";
import { isIpRateLimited } from "../../../lib/server/rate-limit.ts";
import { asSessionRpc, sessionRpcErrorStatus } from "../../../lib/server/session-rpc-client.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, locals, cookies, getClientAddress }) => {
	if (!platform) error(500, "platform unavailable");

	if (!isJsonContentType(request)) error(400, "expected application/json");

	if (await isIpRateLimited(platform.env.RATE_LIMITER, getClientAddress())) {
		error(429, "rate limited");
	}

	// B06: a streamed byte cap runs before any JSON parsing, independent of Content-Length.
	const bodyResult = await readJsonBody(request);
	if (!bodyResult.ok) error(bodyResult.reason === "too_large" ? 413 : 400, "invalid JSON body");

	const parsed = v.safeParse(GameConfigSchema, bodyResult.body);
	if (!parsed.success) error(400, "invalid game config");

	let playerId: string;
	try {
		playerId = await ensureGuestPlayer(
			platform.env.DB,
			platform.env.SESSION_SECRET,
			cookies,
			locals,
			Date.now(),
			platform.env.GUEST_MINT_DAILY_CAP,
		);
	} catch (err) {
		// B03: the global daily guest-mint cap is exhausted. Fail closed with a controlled 503,
		// before any session RPC call.
		if (err instanceof GuestMintCapExceededError) error(503, "service unavailable");
		throw err;
	}

	const session = asSessionRpc(platform.env.SESSION);
	const result = await session.createGame(playerId, parsed.output);
	if (!result.ok) error(sessionRpcErrorStatus(result.error), result.error);

	return json(result.value, { status: 201 });
};
