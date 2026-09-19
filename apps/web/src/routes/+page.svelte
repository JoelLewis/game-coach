<svelte:head>
	<title>GameCoach</title>
</svelte:head>

<main class="landing">
	<div class="landing__frame">
		<span class="landing__mark" aria-hidden="true">♞</span>

		<h1 class="landing__title">GameCoach</h1>

		<p class="landing__lede">
			A chess coach that watches every move and speaks only when it matters — a quiet
			nudge at the moment you need it, nothing during the moves you don't.
		</p>

		<a class="landing__cta" href="/play">
			Play
			<span aria-hidden="true">&rarr;</span>
		</a>

		<p class="landing__footnote">No account needed to start. One game, one board, no noise.</p>
	</div>
</main>

<style>
	.landing {
		min-height: 100dvh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: clamp(1.5rem, 6vw, 4rem);
		background:
			radial-gradient(ellipse 60% 50% at 15% 10%, var(--cm-study-brass-highlight), transparent),
			var(--cm-bg-app);
	}

	.landing__frame {
		max-width: 30rem;
		width: 100%;
	}

	.landing__mark {
		display: inline-block;
		font-size: clamp(2rem, 6vw, 2.75rem);
		color: var(--cm-study-walnut);
		margin-block-end: var(--cm-space-3);
		line-height: 1;
	}

	.landing__title {
		font-family: var(--cm-font-heading);
		font-weight: 400;
		font-size: clamp(2.5rem, 8vw, 4rem);
		line-height: 1.05;
		color: var(--cm-text-primary);
		margin-block-end: var(--cm-space-4);
		letter-spacing: -0.01em;
	}

	.landing__lede {
		font-family: var(--cm-font-body);
		font-size: clamp(1.05rem, 2.2vw, 1.2rem);
		line-height: 1.6;
		color: var(--cm-text-secondary);
		max-width: 34ch;
		margin-block-end: var(--cm-space-8);
	}

	.landing__cta {
		display: inline-flex;
		align-items: center;
		gap: var(--cm-space-2);
		min-height: 44px;
		padding: var(--cm-space-3) var(--cm-space-6);
		background: var(--cm-study-walnut);
		color: var(--cm-text-inverse);
		font-family: var(--cm-font-heading);
		font-size: var(--cm-text-xl);
		text-decoration: none;
		border-radius: var(--cm-radius-sm);
		box-shadow: var(--cm-shadow-md);
		transition:
			transform var(--cm-transition-fast),
			box-shadow var(--cm-transition-fast);
	}

	.landing__cta:hover {
		transform: translateY(-1px);
		box-shadow: var(--cm-shadow-lg);
	}

	.landing__cta span {
		transition: transform var(--cm-transition-fast);
	}

	.landing__cta:hover span {
		transform: translateX(3px);
	}

	.landing__footnote {
		margin-block-start: var(--cm-space-5);
		font-family: var(--cm-font-mono);
		font-size: var(--cm-text-sm);
		color: var(--cm-text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.landing__cta,
		.landing__cta span {
			transition: none;
		}
	}
</style>
