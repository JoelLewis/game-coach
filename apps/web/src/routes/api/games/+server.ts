// POST a GameConfig -> creates a game via the SESSION service binding (apps/session owns the
// Durable Object and D1 writes for games/moves/judgments).
import { error, json } from "@sveltejs/kit";
import * as v from "valibot";
import { GameConfigSchema } from "@game-coach/contracts/session-rpc";
import { asSessionRpc, sessionRpcErrorStatus } from "../../../lib/server/session-rpc-client.ts";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!platform) error(500, "platform unavailable");

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, "invalid JSON body");
	}

	const parsed = v.safeParse(GameConfigSchema, body);
	if (!parsed.success) error(400, "invalid game config");

	const session = asSessionRpc(platform.env.SESSION);
	const result = await session.createGame(locals.playerId, parsed.output);
	if (!result.ok) error(sessionRpcErrorStatus(result.error), result.error);

	return json(result.value, { status: 201 });
};
