// GET /api/games/[id] -> the game summary, via the SESSION service binding. Ownership is
// enforced by SessionEntrypoint.getGameSummary (playerId must own the game); we just map its
// result to an HTTP status.
import { error, json } from "@sveltejs/kit";
import { asSessionRpc, sessionRpcErrorStatus } from "../../../../lib/server/session-rpc-client.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!platform) error(500, "platform unavailable");

	// GET never mints a guest (F03): an identity-less request cannot own any game, so there's no
	// point asking the RPC.
	if (!locals.playerId) error(403, "forbidden");

	const session = asSessionRpc(platform.env.SESSION);
	const result = await session.getGameSummary(locals.playerId, params.id);
	if (!result.ok) error(sessionRpcErrorStatus(result.error), result.error);

	return json(result.value);
};
