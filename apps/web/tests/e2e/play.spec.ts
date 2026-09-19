import { expect, test, type Page } from '@playwright/test';

// `/api/games` and `hooks.server.ts`/session cookie belong to a different task's branch and do
// not exist in this worktree (see COMMON.md). This spec stubs the HTTP response and the
// WebSocket at the browser level so the play flow can be exercised end to end against the real
// chess-core wasm and the real Stockfish worker — only the server is fake.
const STUB_GAME_ID = 'e2e-test-game';

async function stubBackend(page: Page): Promise<void> {
	await page.route('**/api/games', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ gameId: STUB_GAME_ID })
		})
	);

	await page.routeWebSocket(/\/ws\/game\//, (ws) => {
		ws.onMessage((message) => {
			const data: unknown = JSON.parse(String(message));
			if (data && typeof data === 'object' && (data as { type?: string }).type === 'hello') {
				ws.send(
					JSON.stringify({
						type: 'ready',
						serverPly: 0,
						mode: 'live',
						talkativeness: 0.5,
						recentEvents: []
					})
				);
			}
			// move / opponent_move / set_mode / feedback / game_end are accepted and ignored —
			// this spec only asserts client-side board behaviour.
		});
	});
}

function squareCenter(
	box: { x: number; y: number; width: number; height: number },
	square: string,
	orientation: 'white' | 'black' = 'white'
): { x: number; y: number } {
	const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
	const rank = Number(square[1]) - 1;
	const size = box.width / 8;
	const col = orientation === 'white' ? file : 7 - file;
	const row = orientation === 'white' ? 7 - rank : rank;
	return { x: box.x + size * (col + 0.5), y: box.y + size * (row + 0.5) };
}

test('starts a game from /play and makes a move on the board', async ({ page }) => {
	await stubBackend(page);

	await page.goto('/play');
	await page.getByRole('button', { name: 'Start game' }).click();

	await page.waitForURL(new RegExp(`/play/${STUB_GAME_ID}`));

	const board = page.locator('.board-container[role="img"]');
	await expect(board).toBeVisible();
	await expect(board).toHaveAttribute('aria-label', /w KQkq/); // starting position, White to move

	const box = await board.boundingBox();
	if (!box) throw new Error('board has no bounding box');

	const from = squareCenter(box, 'e2');
	const to = squareCenter(box, 'e4');

	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();

	// The board updates optimistically and locally (chess-core wasm), independent of the
	// stubbed server, so the FEN changing is enough to prove the move landed.
	await expect(board).toHaveAttribute('aria-label', /4P3.*b KQkq/);
});
