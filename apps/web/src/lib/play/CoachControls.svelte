<script lang="ts">
	// Off / review-only / live, plus the quiet-to-talkative threshold slider (PRD: "coach off,
	// review-only, or live with a threshold slider (quiet to talkative)"). Collapsed by default
	// — a settings affordance, not a permanent dashboard fixture.
	import type { CoachMode } from '@game-coach/contracts/decision';

	type Props = {
		mode: CoachMode;
		talkativeness: number;
		onChange: (mode: CoachMode, talkativeness: number) => void;
	};

	let { mode, talkativeness, onChange }: Props = $props();

	let expanded = $state(false);

	const MODE_OPTIONS: { value: CoachMode; label: string }[] = [
		{ value: 'off', label: 'Off' },
		{ value: 'review_only', label: 'Review only' },
		{ value: 'live', label: 'Live' }
	];

	function setMode(next: CoachMode): void {
		onChange(next, talkativeness);
	}

	function setTalkativeness(event: Event): void {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		onChange(mode, value);
	}
</script>

<div class="coach-controls">
	<button
		type="button"
		class="coach-controls__toggle"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
	>
		Coach: {MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode}
	</button>

	{#if expanded}
		<div class="coach-controls__panel">
			<div class="coach-controls__segmented" role="radiogroup" aria-label="Coach mode">
				{#each MODE_OPTIONS as option (option.value)}
					<button
						type="button"
						class="coach-controls__segment"
						class:is-active={mode === option.value}
						aria-pressed={mode === option.value}
						onclick={() => setMode(option.value)}
					>
						{option.label}
					</button>
				{/each}
			</div>

			{#if mode === 'live'}
				<label class="coach-controls__slider-row">
					<span class="coach-controls__slider-label">Quiet</span>
					<input
						type="range"
						min="0"
						max="1"
						step="0.05"
						value={talkativeness}
						oninput={setTalkativeness}
						aria-label="Coach talkativeness, quiet to talkative"
					/>
					<span class="coach-controls__slider-label">Talkative</span>
				</label>
			{/if}
		</div>
	{/if}
</div>

<style>
	.coach-controls {
		font-family: var(--cm-font-body);
	}

	.coach-controls__toggle {
		min-height: 44px;
		padding-inline: var(--cm-space-3);
		background: none;
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-sm);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-secondary);
		cursor: pointer;
	}

	.coach-controls__panel {
		margin-block-start: var(--cm-space-3);
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-3);
	}

	.coach-controls__segmented {
		display: flex;
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-md);
		overflow: hidden;
		width: fit-content;
	}

	.coach-controls__segment {
		min-height: 44px;
		padding-inline: var(--cm-space-3);
		background: var(--cm-bg-surface);
		border: none;
		border-inline-start: 1px solid var(--cm-border-medium);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-secondary);
		cursor: pointer;
	}

	.coach-controls__segment:first-child {
		border-inline-start: none;
	}

	.coach-controls__segment.is-active {
		background: var(--cm-study-walnut);
		color: var(--cm-text-inverse);
	}

	.coach-controls__slider-row {
		display: flex;
		align-items: center;
		gap: var(--cm-space-2);
	}

	.coach-controls__slider-row input[type='range'] {
		flex: 1;
		accent-color: var(--cm-study-walnut);
		min-height: 44px;
	}

	.coach-controls__slider-label {
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-xs);
		color: var(--cm-text-faint);
	}
</style>
