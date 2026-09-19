<script lang="ts">
	// The interrupt/praise card. Only ever rendered when the server actually sends a coach
	// event — no card, no chrome, no placeholder the rest of the time (silence is a feature).
	import type { CoachEvent } from '@game-coach/contracts/ws-protocol';

	type Props = {
		event: CoachEvent;
		onFeedback: (helpful: boolean) => void;
		onDismiss: () => void;
	};

	let { event, onFeedback, onDismiss }: Props = $props();

	let revealed = $state(false);
	let answered = $state<boolean | null>(null);

	function giveFeedback(helpful: boolean): void {
		if (answered !== null) return;
		answered = helpful;
		onFeedback(helpful);
	}

	// Re-arm the card's local UI state whenever a genuinely new event is shown.
	let lastEventId = $state<string | null>(null);
	$effect(() => {
		if (event.id !== lastEventId) {
			lastEventId = event.id;
			revealed = false;
			answered = null;
		}
	});
</script>

<article class="coach-card" class:coach-card--praise={event.kind === 'praise'}>
	<button type="button" class="coach-card__dismiss" onclick={onDismiss} aria-label="Dismiss">
		&times;
	</button>

	<p class="coach-card__text">{event.text}</p>

	{#if event.bestLine.length > 0}
		{#if revealed}
			<p class="coach-card__line">{event.bestLine.join(' ')}</p>
		{:else}
			<button type="button" class="coach-card__reveal" onclick={() => (revealed = true)}>
				Show best line
			</button>
		{/if}
	{/if}

	<div class="coach-card__feedback">
		{#if answered === null}
			<span class="coach-card__feedback-label">Helpful?</span>
			<button type="button" class="coach-card__feedback-btn" onclick={() => giveFeedback(true)}>
				Yes
			</button>
			<button type="button" class="coach-card__feedback-btn" onclick={() => giveFeedback(false)}>
				No
			</button>
		{:else}
			<span class="coach-card__feedback-thanks">Thanks.</span>
		{/if}
	</div>
</article>

<style>
	.coach-card {
		position: relative;
		background: var(--cm-bg-surface);
		border: 1px solid var(--cm-border-medium);
		border-inline-start: 3px solid var(--cm-status-warning);
		border-radius: var(--cm-radius-md);
		padding: var(--cm-space-4);
		box-shadow: var(--cm-shadow-sm);
		display: flex;
		flex-direction: column;
		gap: var(--cm-space-3);
	}

	.coach-card--praise {
		border-inline-start-color: var(--cm-status-success);
	}

	.coach-card__dismiss {
		position: absolute;
		top: var(--cm-space-2);
		right: var(--cm-space-2);
		width: 32px;
		height: 32px;
		min-height: 32px;
		border: none;
		background: transparent;
		color: var(--cm-text-faint);
		font-size: var(--cm-text-xl);
		line-height: 1;
		cursor: pointer;
		border-radius: var(--cm-radius-sm);
	}

	.coach-card__dismiss:hover {
		background: var(--cm-bg-hover);
		color: var(--cm-text-secondary);
	}

	.coach-card__text {
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-lg);
		line-height: 1.5;
		color: var(--cm-text-primary);
		padding-inline-end: var(--cm-space-6);
	}

	.coach-card__reveal {
		align-self: flex-start;
		min-height: 44px;
		padding-inline: var(--cm-space-3);
		background: none;
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-sm);
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-secondary);
		cursor: pointer;
	}

	.coach-card__reveal:hover {
		border-color: var(--cm-study-walnut);
		color: var(--cm-text-primary);
	}

	.coach-card__line {
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-base);
		color: var(--cm-text-secondary);
		background: var(--cm-bg-surface-alt);
		border-radius: var(--cm-radius-sm);
		padding: var(--cm-space-2) var(--cm-space-3);
	}

	.coach-card__feedback {
		display: flex;
		align-items: center;
		gap: var(--cm-space-2);
	}

	.coach-card__feedback-label {
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-muted);
	}

	.coach-card__feedback-btn {
		min-height: 36px;
		min-width: 44px;
		padding-inline: var(--cm-space-3);
		border: 1px solid var(--cm-border-medium);
		border-radius: var(--cm-radius-full);
		background: none;
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-sm);
		cursor: pointer;
		color: var(--cm-text-secondary);
	}

	.coach-card__feedback-btn:hover {
		border-color: var(--cm-study-walnut);
		color: var(--cm-text-primary);
	}

	.coach-card__feedback-thanks {
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-faint);
		font-style: italic;
	}
</style>
