// Loads whatever `GET /api/games/[id]/state` can tell us about this game before the page
// renders, so a hard reload rebuilds the board from real history instead of depending on URL
// query params. A universal load (not `+page.server.ts`): the state endpoint itself already
// enforces ownership and never mints a guest on GET, so nothing here needs `platform`/`locals`.
// A missing/unreadable/forbidden state is not a load failure -- the page falls back to reading
// side/level/mode from the URL for a game the endpoint can't (yet) find.
import * as v from "valibot";
import { GameStateSchema, type GameState } from "@game-coach/contracts/session-rpc";
import type { PageLoad } from "./$types";

export type PlayPageData = {
	gameId: string;
	gameState: GameState | null;
};

// Not annotated as `: PageLoad` on the const itself — that collapses the exported function's
// type to `PageLoad`'s generic default (`OutputDataShape<...>`, which includes `void`), which is
// how `./$types`'s `PageData` is inferred elsewhere. Typing only the parameter keeps this
// function's own return type (`Promise<PlayPageData>`) visible to that inference.
export const load = async ({ fetch, params }: Parameters<PageLoad>[0]): Promise<PlayPageData> => {
	const gameId = params.gameId;

	let response: Response;
	try {
		response = await fetch(`/api/games/${gameId}/state`);
	} catch {
		return { gameId, gameState: null };
	}
	if (!response.ok) return { gameId, gameState: null };

	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		return { gameId, gameState: null };
	}

	const parsed = v.safeParse(GameStateSchema, raw);
	return { gameId, gameState: parsed.success ? parsed.output : null };
};
