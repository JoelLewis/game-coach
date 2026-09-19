<script lang="ts">
  import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
  import type { Progress } from "../progress.ts";

  type Props = { progress: Progress; currentPosition: number };
  const { progress, currentPosition }: Props = $props();

  const SEVERITY_COLORS = ["var(--sev-0)", "var(--sev-1)", "var(--sev-2)", "var(--sev-3)"] as const;
  const pct = $derived(progress.total === 0 ? 0 : Math.round((progress.labeledCount / progress.total) * 100));
  const acceptedPct = $derived(progress.acceptedRate === null ? null : Math.round(progress.acceptedRate * 100));
  // A sustained rubber-stamp rate is worth a quiet nudge, not a blocker.
  const anchoringWarning = $derived(progress.labeledCount >= 10 && (progress.acceptedRate ?? 0) > 0.92);
</script>

<div class="progress" aria-label="Labeling progress">
  <div class="headline">
    <span class="count mono">{currentPosition} / {progress.total}</span>
    <span class="sep">&middot;</span>
    <span class="labeled mono">{progress.labeledCount} labeled ({pct}%)</span>
  </div>

  <div class="bar" role="img" aria-label="{pct}% labeled">
    <div class="bar-fill" style:width="{pct}%"></div>
  </div>

  <div class="balance">
    {#each SEVERITY_LEVELS as name, index (name)}
      <span class="sev-count">
        <span class="dot" style:background={SEVERITY_COLORS[index]}></span>
        <span class="mono">{progress.bySeverity[index as 0 | 1 | 2 | 3]}</span>
        <span class="sev-name">{name}</span>
      </span>
    {/each}
  </div>

  {#if acceptedPct !== null}
    <p class="accepted" class:warn={anchoringWarning}>
      accepted unchanged: <span class="mono">{acceptedPct}%</span>
      {#if anchoringWarning}<span class="hint">— check you're not just rubber-stamping</span>{/if}
    </p>
  {/if}
</div>

<style>
  .progress {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .headline {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--ink-dim);
  }

  .count {
    color: var(--ink);
    font-weight: 700;
  }

  .sep {
    color: var(--ink-faint);
  }

  .bar {
    height: 4px;
    background: var(--surface-raised);
    border-radius: 999px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--accent-proposal);
    transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .balance {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
  }

  .sev-count {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    color: var(--ink-faint);
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }

  .sev-name {
    text-transform: capitalize;
  }

  .accepted {
    margin: 0;
    font-size: 0.72rem;
    color: var(--ink-faint);
  }

  .accepted.warn {
    color: var(--accent-warning);
  }

  .hint {
    font-style: italic;
  }
</style>
