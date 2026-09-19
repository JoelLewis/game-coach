<script lang="ts">
	// The wordless "coach is watching" indicator (PRD: "a quiet indicator shows the coach is
	// watching... without words"). A calm dot that pulses while idle and briefly tints toward
	// the last judgment's severity token, then fades back — no text, ever.
	import type { JudgmentInfo } from './game-socket.svelte.ts';
	import type { CoachMode } from '@game-coach/contracts/decision';
	import { SEVERITY_LABELS, SEVERITY_TOKENS } from '@game-coach/ui-study/components/severity.ts';

	type Props = {
		mode: CoachMode | null;
		lastJudgment: JudgmentInfo | null;
	};

	let { mode, lastJudgment }: Props = $props();

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
	let isFlashing = $derived(!isOff && flashPly !== null && flashPly === lastJudgment?.ply);
	let color = $derived(
		isFlashing && lastJudgment ? SEVERITY_TOKENS[lastJudgment.severity] : 'var(--cm-text-faint)'
	);
	let label = $derived(
		isOff
			? 'Coaching is off'
			: isFlashing && lastJudgment
				? `Last move: ${SEVERITY_LABELS[lastJudgment.severity].toLowerCase()}`
				: 'Coach is watching'
	);
</script>

<div class="quiet-indicator" title={label}>
	<span
		class="quiet-indicator__dot"
		class:is-pulsing={!isOff && !isFlashing}
		style:--dot-color={color}
		role="status"
		aria-label={label}
	></span>
</div>

<style>
	.quiet-indicator {
		display: inline-flex;
		align-items: center;
	}

	.quiet-indicator__dot {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--dot-color);
		transition: background-color var(--cm-transition-slow);
	}

	.quiet-indicator__dot.is-pulsing {
		animation: quiet-pulse 2.4s ease-in-out infinite;
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
