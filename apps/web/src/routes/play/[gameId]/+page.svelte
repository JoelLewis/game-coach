<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Chessboard from '@game-coach/ui-study/components/Chessboard.svelte';
	import MoveList from '@game-coach/ui-study/components/MoveList.svelte';
	import type { Severity } from '@game-coach/ui-study/components/severity.ts';
	import type { CoachMode } from '@game-coach/contracts/decision';
	import type { CoachEvent } from '@game-coach/contracts/ws-protocol';
	import { createGameSocket } from '$lib/play/game-socket.svelte';
	import { createGameController, toOpponentLevel, type Side } from '$lib/play/game-controller.svelte';
	import QuietIndicator from '$lib/play/QuietIndicator.svelte';
	import CoachCard from '$lib/play/CoachCard.svelte';
	import CoachControls from '$lib/play/CoachControls.svelte';

	const gameIdParam = page.params.gameId;
	if (!gameIdParam) {
		throw new Error('missing gameId route param');
	}
	const gameId = gameIdParam;

	// The new-game form passes the config it already posted to /api/games along in the URL —
	// there is no documented GET endpoint to read a GameConfig back, so a bare/reloaded link
	// falls back to sensible defaults rather than erroring (see the final report's contract
	// notes on page-reload rehydration).
	const params = page.url.searchParams;
	const playerSide: Side = params.get('side') === 'black' ? 'black' : 'white';
	const opponentLevel = toOpponentLevel(Number(params.get('level')) || 4);
	const initialModeParam = params.get('mode');
	const initialMode: CoachMode =
		initialModeParam === 'off' || initialModeParam === 'review_only' || initialModeParam === 'live'
			? initialModeParam
			: 'live';

	const gameSocket = createGameSocket({ gameId, initialLastPly: 0 });
	gameSocket.connect();

	const controller = createGameController({
		playerSide,
		opponentLevel,
		startPosition: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
		socket: gameSocket
	});

	let coachMode = $state<CoachMode>(initialMode);
	let talkativeness = $state(0.5);
	let syncedModeFromServer = false;

	$effect(() => {
		if (!syncedModeFromServer && gameSocket.mode !== null) {
			coachMode = gameSocket.mode;
			talkativeness = gameSocket.talkativeness ?? 0.5;
			syncedModeFromServer = true;
		}
	});

	function handleCoachModeChange(nextMode: CoachMode, nextTalkativeness: number): void {
		coachMode = nextMode;
		talkativeness = nextTalkativeness;
		gameSocket.sendSetMode(nextMode, nextTalkativeness);
	}

	// The judgment stream only carries the latest ply; accumulate it here so the move list can
	// show a severity chip per move without the socket having to keep a full history itself.
	let judgmentByPly = $state<Map<number, Severity>>(new Map());
	$effect(() => {
		const judgment = gameSocket.lastJudgment;
		if (!judgment) return;
		judgmentByPly = new Map(judgmentByPly).set(judgment.ply, judgment.severity as Severity);
	});

	let dismissedEventIds = $state<Set<string>>(new Set());
	let activeCoachEvent = $derived.by((): CoachEvent | null => {
		for (let i = gameSocket.events.length - 1; i >= 0; i -= 1) {
			const event = gameSocket.events[i];
			if (event && (event.kind === 'interrupt' || event.kind === 'praise') && !dismissedEventIds.has(event.id)) {
				return event;
			}
		}
		return null;
	});

	function dismissCoachEvent(eventId: string): void {
		dismissedEventIds = new Set(dismissedEventIds).add(eventId);
	}

	let boardHighlights = $derived(activeCoachEvent?.kind === 'interrupt' ? activeCoachEvent.highlights : []);

	let moveListItems = $derived(
		controller.moves.map((move) => ({ ply: move.ply, san: move.san, severity: judgmentByPly.get(move.ply) }))
	);
	let lastPly = $derived(controller.moves.at(-1)?.ply ?? null);

	let confirmingResign = $state(false);
	function handleResign(): void {
		if (!confirmingResign) {
			confirmingResign = true;
			return;
		}
		confirmingResign = false;
		controller.resign();
	}

	$effect(() => {
		return () => {
			controller.dispose();
			gameSocket.close();
		};
	});
</script>

<svelte:head>
	<title>Playing — GameCoach</title>
</svelte:head>

<div class="game-page">
	<header class="game-page__header">
		<a class="game-page__new" href="/play">New game</a>
		<QuietIndicator mode={coachMode} lastJudgment={gameSocket.lastJudgment} />
		<div class="game-page__resign">
			{#if controller.status === 'playing'}
				{#if confirmingResign}
					<button type="button" class="game-page__resign-confirm" onclick={handleResign}>
						Really resign?
					</button>
					<button
						type="button"
						class="game-page__resign-cancel"
						onclick={() => (confirmingResign = false)}
					>
						Cancel
					</button>
				{:else}
					<button type="button" class="game-page__resign-btn" onclick={handleResign}> Resign </button>
				{/if}
			{/if}
		</div>
	</header>

	<div class="game-page__layout">
		<div class="board-shell">
			<Chessboard
				fen={controller.board.fen}
				orientation={controller.board.orientation}
				turnColor={controller.board.turnColor}
				dests={controller.board.dests}
				lastMove={controller.board.lastMove}
				isCheck={controller.board.isCheck}
				highlights={boardHighlights}
				viewOnly={controller.status === 'ended'}
				onMove={(from, to, promotion) => controller.playerMove(from, to, promotion)}
			/>
		</div>

		<aside class="coaching-panel" aria-label="Coach">
			{#if controller.status === 'ended' && controller.result}
				<p class="coaching-panel__result">
					{#if controller.result === 'player_win'}
						You won.
					{:else if controller.result === 'player_loss'}
						You lost.
					{:else}
						Draw.
					{/if}
				</p>
			{/if}

			<div aria-live="polite" aria-atomic="true">
				{#if activeCoachEvent}
					<CoachCard
						event={activeCoachEvent}
						onFeedback={(helpful) => gameSocket.sendFeedback(activeCoachEvent!.id, helpful)}
						onDismiss={() => dismissCoachEvent(activeCoachEvent!.id)}
					/>
				{/if}
			</div>

			<div class="coaching-panel__moves">
				<MoveList moves={moveListItems} currentPly={lastPly} onSelect={() => {}} />
			</div>

			<CoachControls mode={coachMode} {talkativeness} onChange={handleCoachModeChange} />
		</aside>
	</div>
</div>

<style>
	.game-page {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		padding: clamp(0.75rem, 3vw, 1.5rem);
		gap: var(--cm-space-4);
	}

	.game-page__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--cm-space-3);
	}

	.game-page__new {
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-muted);
		text-decoration: none;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
	}

	.game-page__new:hover {
		color: var(--cm-text-primary);
	}

	.game-page__resign-btn,
	.game-page__resign-confirm,
	.game-page__resign-cancel {
		min-height: 44px;
		padding-inline: var(--cm-space-3);
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-sm);
		background: none;
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-secondary);
		cursor: pointer;
	}

	.game-page__resign-confirm {
		border-color: var(--cm-status-error);
		color: var(--cm-status-error);
		margin-inline-end: var(--cm-space-2);
	}

	/* The board is deliberately sized by width here (phone-first, no horizontal scroll),
	   overriding Chessboard's own vh-based sizing, which assumes a fixed-panel desktop
	   layout — see the final report for why this can't be fixed inside ui-study instead. */
	.board-shell {
		width: min(92vw, 560px);
		aspect-ratio: 1;
		margin-inline: auto;
	}

	.board-shell :global(.board-container),
	.board-shell :global(.board) {
		width: 100% !important;
		height: 100% !important;
	}

	.game-page__layout {
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-5);
		flex: 1;
	}

	.coaching-panel {
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-3);
		width: 100%;
		max-width: 560px;
		margin-inline: auto;
	}

	.coaching-panel__result {
		font-family: var(--cm-font-heading);
		font-size: var(--cm-text-2xl);
		color: var(--cm-text-primary);
	}

	.coaching-panel__moves {
		background: var(--cm-bg-surface);
		border: 1px solid var(--cm-border-light);
		border-radius: var(--cm-radius-md);
	}

	@media (min-width: 768px) {
		.game-page__layout {
			flex-direction: row;
			align-items: flex-start;
			justify-content: center;
		}

		.board-shell {
			width: min(60vw, 560px);
			margin-inline: 0;
			flex: 0 0 auto;
		}

		.coaching-panel {
			flex: 1 1 320px;
			max-width: 380px;
			margin-inline: 0;
		}
	}
</style>
