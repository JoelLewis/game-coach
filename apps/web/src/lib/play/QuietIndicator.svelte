<script lang="ts">
	// The wordless "coach is watching" indicator (PRD: "a quiet indicator shows the coach is
	// watching... without words") — with one deliberate exception. When the coach goes quiet for
	// a reason the player didn't choose (`budget`/`jev_unavailable`, as opposed to `coach_off`,
	// which they did), a wordless dot reads as "broken", not "quiet". Those two reasons get a
	// calm, static, visually distinct shape plus a short label so a reload or dashed-out day
	// doesn't look like a bug. No modal, no toast — the game keeps going underneath it.
	import type { JudgmentInfo, UnjudgedReason } from './game-socket.svelte.ts';
	import type { CoachMode } from '@game-coach/contracts/decision';
	import { SEVERITY_LABELS, SEVERITY_TOKENS } from '@game-coach/ui-study/components/severity.ts';

	type Props = {
		mode: CoachMode | null;
		lastJudgment: JudgmentInfo | null;
		unjudgedReason?: UnjudgedReason | null;
	};

	let { mode, lastJudgment, unjudgedReason = null }: Props = $props();

	const FLASH_MS = 4000;

	let flashPly = $state<number | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const judgment = lastJudgment;
		if (!judgment) return;
		flashPly = judgment.ply;
		clearTimeout(timer);
		timer = setTimeout(() => {
			flashPly = null;
		}, FLASH_MS);
		return () => clearTimeout(timer);
	});

	let isOff = $derived(mode === 'off' || mode === null);
	// Coaching being off is itself a not-by-choice-free state the player picked; a paused budget
	// or a down Jev transport are not, so they only apply while coaching would otherwise be live.
	let isPaused = $derived(!isOff && unjudgedReason === 'budget');
	let isUnavailable = $derived(!isOff && unjudgedReason === 'jev_unavailable');
	let isFlashing = $derived(
		!isOff && !isPaused && !isUnavailable && flashPly !== null && flashPly === lastJudgment?.ply
	);

	let color = $derived(
		isPaused
			? 'var(--cm-accent-secondary)'
			: isUnavailable
				? 'var(--cm-text-muted)'
				: isFlashing && lastJudgment
					? SEVERITY_TOKENS[lastJudgment.severity]
					: 'var(--cm-text-faint)'
	);
	let label = $derived(
		isOff
			? 'Coaching is off'
			: isPaused
				? 'Coach paused: daily limit reached'
				: isUnavailable
					? 'Coach unavailable, your game continues'
					: isFlashing && lastJudgment
						? `Last move: ${SEVERITY_LABELS[lastJudgment.severity].toLowerCase()}`
						: 'Coach is watching'
	);
</script>

<div class="quiet-indicator" title={label}>
	<span
		class="quiet-indicator__dot"
		class:is-pulsing={!isOff && !isFlashing && !isPaused && !isUnavailable}
		class:is-paused={isPaused}
		class:is-unavailable={isUnavailable}
		style:--dot-color={color}
		role="status"
		aria-label={label}
	></span>
	{#if isPaused || isUnavailable}
		<span class="quiet-indicator__text">{label}</span>
	{/if}
</div>

<style>
	.quiet-indicator {
		display: inline-flex;
		align-items: center;
		gap: var(--cm-space-2);
	}

	.quiet-indicator__dot {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--dot-color);
		transition:
			background-color var(--cm-transition-slow),
			border-color var(--cm-transition-slow);
	}

	.quiet-indicator__dot.is-pulsing {
		animation: quiet-pulse 2.4s ease-in-out infinite;
	}

	/* Calm and static (never pulses): a paused budget or an unavailable coach is not something
	   to draw the eye to repeatedly, just something to be honest about once. */
	.quiet-indicator__dot.is-paused {
		background: transparent;
		border: 2px solid var(--dot-color);
		width: 8px;
		height: 8px;
	}

	.quiet-indicator__dot.is-unavailable {
		background: transparent;
		border: 2px dashed var(--dot-color);
		width: 8px;
		height: 8px;
	}

	.quiet-indicator__text {
		font-family: var(--cm-font-body);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-muted);
		white-space: nowrap;
	}

	@keyframes quiet-pulse {
		0%,
		100% {
			opacity: 0.45;
			transform: scale(1);
		}
		50% {
			opacity: 0.9;
			transform: scale(1.15);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.quiet-indicator__dot.is-pulsing {
			animation: none;
			opacity: 0.7;
		}
		.quiet-indicator__dot {
			transition: none;
		}
	}
</style>
