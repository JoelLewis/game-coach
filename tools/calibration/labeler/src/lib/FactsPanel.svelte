<script lang="ts">
  import type { MoveFacts } from "@game-coach/contracts/engine";
  import type { RatingBand } from "@game-coach/contracts/taxonomy";
  import {
    formatClock, formatEval, formatFeatureValue, formatPhase, formatRatingBand,
    formatSwing, isTacticsFeature, prettifyFeatureKey,
  } from "../format.ts";

  type Props = { facts: MoveFacts; ratingBand: RatingBand };
  const { facts, ratingBand }: Props = $props();

  const best = $derived(facts.bestLines[0]);
  const tacticsFeatures = $derived(Object.entries(facts.features).filter(([key]) => isTacticsFeature(key)));
  const otherFeatures = $derived(Object.entries(facts.features).filter(([key]) => !isTacticsFeature(key)));
</script>

<section class="facts" aria-label="Move facts">
  <div class="row moves">
    <div class="move-cell">
      <span class="cell-label">played</span>
      <span class="cell-value mono">{facts.moveText}</span>
    </div>
    <div class="move-cell">
      <span class="cell-label">best</span>
      <span class="cell-value mono">{best?.line[0] ?? "—"}</span>
    </div>
    <div class="move-cell">
      <span class="cell-label">swing</span>
      <span class="cell-value mono swing" class:negative={facts.swing < 0} class:positive={facts.swing > 0}>
        {formatSwing(facts.swing)}
      </span>
    </div>
  </div>

  <div class="row evals">
    <div class="eval-cell">
      <span class="cell-label">eval before</span>
      <span class="cell-value mono">{formatEval(facts.evalBefore)}</span>
    </div>
    <div class="eval-cell">
      <span class="cell-label">eval after</span>
      <span class="cell-value mono">{formatEval(facts.evalAfter)}</span>
    </div>
  </div>

  {#if best && best.line.length > 1}
    <p class="line"><span class="cell-label">best line</span> <span class="mono">{best.line.join(" ")}</span></p>
  {/if}
  {#if facts.playedLine.length > 1}
    <p class="line"><span class="cell-label">line after played</span> <span class="mono">{facts.playedLine.slice(1).join(" ")}</span></p>
  {/if}

  <div class="chips">
    <span class="tag">{formatPhase(facts.phase)}</span>
    <span class="tag">{formatRatingBand(ratingBand)}</span>
    <span class="tag mono">clock {formatClock(facts.clockMs)}</span>
    <span class="tag mono">depth {facts.depth}</span>
  </div>

  {#if tacticsFeatures.length > 0}
    <div class="features">
      <span class="cell-label">tactics</span>
      <ul>
        {#each tacticsFeatures as [key, value] (key)}
          <li><strong>{prettifyFeatureKey(key)}</strong>: {formatFeatureValue(value)}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if otherFeatures.length > 0}
    <details class="features other">
      <summary>other features ({otherFeatures.length})</summary>
      <ul>
        {#each otherFeatures as [key, value] (key)}
          <li><strong>{prettifyFeatureKey(key)}</strong>: {formatFeatureValue(value)}</li>
        {/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  .facts {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .row {
    display: flex;
    gap: 1.25rem;
  }

  .move-cell,
  .eval-cell {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .cell-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-faint);
  }

  .cell-value {
    font-size: 1.05rem;
  }

  .swing.positive {
    color: var(--accent-good);
  }

  .swing.negative {
    color: var(--accent-danger);
  }

  .line {
    margin: 0;
    font-size: 0.85rem;
    color: var(--ink-dim);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .tag {
    font-size: 0.72rem;
    padding: 0.15rem 0.5rem;
    background: var(--surface-raised);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    color: var(--ink-dim);
  }

  .features ul {
    margin: 0.25rem 0 0;
    padding-left: 1.1rem;
    font-size: 0.82rem;
    color: var(--ink-dim);
  }

  .features.other summary {
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--ink-faint);
  }
</style>
