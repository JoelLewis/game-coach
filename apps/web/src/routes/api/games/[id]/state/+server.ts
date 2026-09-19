// GET /api/games/[id]/state -> everything the play page needs to rebuild a game after a hard
// reload (config, move history, judgments, recent coach events, mode). Ownership is enforced by
// SessionEntrypoint.getGameState exactly like /api/games/[id]'s summary endpoint.
import { error, json } from "@sveltejs/kit";
import { asSessionRpc, sessionRpcErrorStatus } from "../../../../../lib/server/session-rpc-client.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!platform) error(500, "platform unavailable");

	// GET never mints a guest (F03): an identity-less request cannot own any game, so there's no
	// point asking the RPC.
	if (!locals.playerId) error(403, "forbidden");

	const session = asSessionRpc(platform.env.SESSION);
	const result = await session.getGameState(locals.playerId, params.id);
	if (!result.ok) error(sessionRpcErrorStatus(result.error), result.error);

	// This reflects a live game's current judgments/mode, which can change from one request to
	// the next -- never cache it.
	return json(result.value, { headers: { "Cache-Control": "no-store" } });
};
