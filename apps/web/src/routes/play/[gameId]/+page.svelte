<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import Chessboard from '@game-coach/ui-study/components/Chessboard.svelte';
	import MoveList from '@game-coach/ui-study/components/MoveList.svelte';
	import type { Severity } from '@game-coach/ui-study/components/severity.ts';
	import type { CoachMode } from '@game-coach/contracts/decision';
	import type { CoachEvent } from '@game-coach/contracts/ws-protocol';
	import { createGameSocket } from '$lib/play/game-socket.svelte';
	import {
		createGameController,
		toOpponentLevel,
		type ResumeFrom,
		type Side
	} from '$lib/play/game-controller.svelte';
	import QuietIndicator from '$lib/play/QuietIndicator.svelte';
	import CoachCard from '$lib/play/CoachCard.svelte';
	import CoachControls from '$lib/play/CoachControls.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const gameIdParam = page.params.gameId;
	if (!gameIdParam) {
		throw new Error('missing gameId route param');
	}
	const gameId = gameIdParam;

	// `+page.ts`'s load already fetched /api/games/[id]/state; `null` here means it couldn't (a
	// game the endpoint can't yet find, a network hiccup, or a stale/expired session) rather than
	// "this game has no history" — a brand-new game still round-trips through the state endpoint
	// and comes back with an empty move list. Read once (`untrack`): the socket/controller this
	// hydrates are themselves created once below, not rebuilt if `data` were ever to change.
	const gameState = untrack(() => data.gameState);

	// The new-game form passes the config it already posted to /api/games along in the URL. That
	// remains the fallback for a game the state endpoint cannot (yet) find; whenever `gameState`
	// is available, it — not the URL — is authoritative, since it reflects the game's actual
	// config and current mode/talkativeness rather than what the form happened to post.
	const params = page.url.searchParams;
	const fallbackSide: Side = params.get('side') === 'black' ? 'black' : 'white';
	const fallbackLevel = toOpponentLevel(Number(params.get('level')) || 4);
	const fallbackModeParam = params.get('mode');
	const fallbackMode: CoachMode =
		fallbackModeParam === 'off' || fallbackModeParam === 'review_only' || fallbackModeParam === 'live'
			? fallbackModeParam
			: 'live';

	const playerSide: Side = gameState?.config.playerSide ?? fallbackSide;
	const opponentLevel = gameState ? toOpponentLevel(gameState.config.opponentLevel) : fallbackLevel;
	const initialMode: CoachMode = gameState?.mode ?? fallbackMode;
	const initialTalkativeness = gameState?.talkativeness ?? 0.5;

	// A finished/abandoned game replays to its final position and opens read-only (see
	// `controller.status === 'ended'`, used below for the board's `viewOnly`) — it never
	// resends `game_end`, since hydration only replays history through chess-core.
	const resumeFrom: ResumeFrom | undefined = gameState
		? {
				moves: gameState.moves.map((move) => ({ ply: move.ply, moveId: move.moveId })),
				finished: gameState.summary.status !== 'live' ? { result: gameState.summary.result ?? 'draw' } : null
			}
		: undefined;

	const gameSocket = createGameSocket({
		gameId,
		initialLastPly: gameState?.summary.lastPly ?? 0,
		initialEvents: gameState?.recentEvents
	});
	gameSocket.connect();

	const controller = createGameController({
		playerSide,
		opponentLevel,
		startPosition: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
		socket: gameSocket,
		resumeFrom
	});

	let coachMode = $state<CoachMode>(initialMode);
	let talkativeness = $state(initialTalkativeness);
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
	// Seeded from the hydrated state so a reload doesn't lose every chip except the next move's.
	let judgmentByPly = $state<Map<number, Severity>>(
		new Map(gameState?.judgments.map((judgment) => [judgment.ply, judgment.severity as Severity]))
	);
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
		<QuietIndicator
			mode={coachMode}
			lastJudgment={gameSocket.lastJudgment}
			unjudgedReason={gameSocket.unjudgedReason}
		/>
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

	/* Chessboard now sizes itself from this container's width (aspect-ratio, no vh) - the page
	   just has to constrain that width, phone-first with no horizontal scroll. */
	.board-shell {
		width: min(92vw, 560px);
		margin-inline: auto;
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
