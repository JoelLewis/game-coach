<script lang="ts">
	import { goto } from '$app/navigation';
	import type { CoachMode } from '@game-coach/contracts/decision';
	import type { GameConfig } from '@game-coach/contracts/session-rpc';
	import { STANDARD_START_FEN, type Side } from '$lib/play/game-controller.svelte';

	const LEVEL_LABELS: Record<number, string> = {
		1: 'Learning',
		2: 'Learning',
		3: 'Club',
		4: 'Club',
		5: 'Strong club',
		6: 'Strong club',
		7: 'Expert',
		8: 'Expert'
	};

	const MODE_OPTIONS: { value: CoachMode; label: string; hint: string }[] = [
		{ value: 'off', label: 'Off', hint: 'Just a board and an opponent.' },
		{ value: 'review_only', label: 'Review only', hint: 'Coaching waits for the post-game review.' },
		{ value: 'live', label: 'Live', hint: 'A quiet interrupt on moves that matter.' }
	];

	let side = $state<Side | 'random'>('white');
	let opponentLevel = $state(4);
	let mode = $state<CoachMode>('live');
	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);

	const resolvedSide = (): Side => (side === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : side);

	async function startGame(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (submitting) return;
		submitting = true;
		errorMessage = null;

		const config: GameConfig = {
			game: 'chess',
			source: 'played',
			playerSide: resolvedSide(),
			opponentLevel,
			timeControl: 'untimed',
			startPosition: STANDARD_START_FEN,
			mode,
			talkativeness: 0.5
		};

		try {
			const response = await fetch('/api/games', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(config)
			});

			if (response.status === 429) {
				errorMessage = "That's the day's games. Back tomorrow.";
				return;
			}
			if (!response.ok) {
				errorMessage = "Couldn't start the game. Try again.";
				return;
			}

			const body: unknown = await response.json();
			const gameId = (body as { gameId?: unknown }).gameId;
			if (typeof gameId !== 'string' || gameId.length === 0) {
				errorMessage = "Couldn't start the game. Try again.";
				return;
			}
			// There is no GET endpoint to read a GameConfig back, so the game page reads its
			// side/level/mode from the URL instead of re-fetching them.
			const query = new URLSearchParams({
				side: config.playerSide,
				level: String(config.opponentLevel),
				mode: config.mode
			});
			await goto(`/play/${gameId}?${query}`);
		} catch {
			errorMessage = 'No connection. Try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>New game — GameCoach</title>
</svelte:head>

<main class="setup">
	<form class="setup__card" onsubmit={startGame}>
		<h1 class="setup__title">New game</h1>

		<fieldset class="setup__field">
			<legend class="setup__label">Side</legend>
			<div class="segmented" role="radiogroup" aria-label="Side">
				{#each [
					{ value: 'white' as const, label: 'White' },
					{ value: 'black' as const, label: 'Black' },
					{ value: 'random' as const, label: 'Random' }
				] as option (option.value)}
					<button
						type="button"
						class="segmented__option"
						class:is-active={side === option.value}
						aria-pressed={side === option.value}
						onclick={() => (side = option.value)}
					>
						{option.label}
					</button>
				{/each}
			</div>
		</fieldset>

		<fieldset class="setup__field">
			<legend class="setup__label" id="level-label">
				Opponent — level {opponentLevel} <span class="setup__label-hint">({LEVEL_LABELS[opponentLevel]})</span>
			</legend>
			<input
				type="range"
				min="1"
				max="8"
				step="1"
				bind:value={opponentLevel}
				aria-labelledby="level-label"
				class="setup__slider"
			/>
			<div class="setup__slider-ticks" aria-hidden="true">
				<span>Weaker</span>
				<span>Stronger</span>
			</div>
		</fieldset>

		<fieldset class="setup__field">
			<legend class="setup__label">Coaching</legend>
			<div class="setup__mode-options">
				{#each MODE_OPTIONS as option (option.value)}
					<label class="mode-option" class:is-active={mode === option.value}>
						<input type="radio" name="mode" value={option.value} bind:group={mode} />
						<span class="mode-option__label">{option.label}</span>
						<span class="mode-option__hint">{option.hint}</span>
					</label>
				{/each}
			</div>
		</fieldset>

		{#if errorMessage}
			<p class="setup__error" role="alert">{errorMessage}</p>
		{/if}

		<button type="submit" class="setup__submit" disabled={submitting}>
			{submitting ? 'Starting…' : 'Start game'}
		</button>
	</form>
</main>

<style>
	.setup {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: clamp(1rem, 5vw, 3rem);
	}

	.setup__card {
		width: 100%;
		max-width: 26rem;
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-6);
	}

	.setup__title {
		font-family: var(--cm-font-heading);
		font-weight: 400;
		font-size: clamp(1.75rem, 5vw, 2.25rem);
		color: var(--cm-text-primary);
	}

	.setup__field {
		border: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-2);
	}

	.setup__label {
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-sm);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--cm-text-muted);
		padding: 0;
	}

	.setup__label-hint {
		text-transform: none;
		letter-spacing: normal;
		color: var(--cm-text-faint);
	}

	.segmented {
		display: flex;
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-md);
		overflow: hidden;
	}

	.segmented__option {
		flex: 1;
		min-height: 44px;
		border: none;
		background: var(--cm-bg-surface);
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-base);
		color: var(--cm-text-secondary);
		cursor: pointer;
		border-inline-start: 1px solid var(--cm-border-medium);
	}

	.segmented__option:first-child {
		border-inline-start: none;
	}

	.segmented__option.is-active {
		background: var(--cm-study-walnut);
		color: var(--cm-text-inverse);
	}

	.setup__slider {
		width: 100%;
		accent-color: var(--cm-study-walnut);
		min-height: 44px;
	}

	.setup__slider-ticks {
		display: flex;
		justify-content: space-between;
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-xs);
		color: var(--cm-text-faint);
	}

	.setup__mode-options {
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-2);
	}

	.mode-option {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: var(--cm-space-3);
		align-items: baseline;
		padding: var(--cm-space-3);
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-md);
		cursor: pointer;
		min-height: 44px;
	}

	.mode-option.is-active {
		border-color: var(--cm-study-walnut);
		background: var(--cm-bg-surface-alt);
	}

	.mode-option input {
		accent-color: var(--cm-study-walnut);
		margin-block-start: 0.35em;
	}

	.mode-option__label {
		font-family: var(--cm-font-body);
		font-weight: 600;
		color: var(--cm-text-primary);
	}

	.mode-option__hint {
		grid-column: 2;
		font-size: var(--cm-text-sm);
		color: var(--cm-text-muted);
	}

	.setup__error {
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-sm);
		color: var(--cm-status-error);
	}

	.setup__submit {
		min-height: 44px;
		padding: var(--cm-space-3) var(--cm-space-6);
		background: var(--cm-study-walnut);
		color: var(--cm-text-inverse);
		font-family: var(--cm-font-heading);
		font-size: var(--cm-text-lg);
		border: none;
		border-radius: var(--cm-radius-sm);
		cursor: pointer;
		box-shadow: var(--cm-shadow-md);
	}

	.setup__submit:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
