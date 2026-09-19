<script lang="ts">
  import type { Eval } from "@game-coach/contracts/engine";
  import { evalToCp } from "@game-coach/contracts/engine";

  type Color = "white" | "black";

  type Props = {
    // Always from the coached player's point of view (positive is good for
    // them), per the contract. `null` while no evaluation is available yet.
    score: Eval | null;
    playerSide: Color;
    // Live play should not show the bar; callers opt in explicitly.
    visible?: boolean;
  };

  let { score, playerSide, visible = false }: Props = $props();

  // Centipawns from White's point of view, independent of who is being
  // coached, so the fill direction is stable no matter which side plays.
  let whiteCp = $derived.by(() => {
    if (score === null) return 0;
    const playerCp = evalToCp(score);
    return playerSide === "white" ? playerCp : -playerCp;
  });

  // Sigmoid-ish scaling: ±400cp maps to roughly 0.1-0.9 of the bar.
  let whiteFraction = $derived(1 / (1 + Math.pow(10, -whiteCp / 400)));
  let whiteHeight = $derived(whiteFraction * 100);

  function formatScore(value: Eval | null): string {
    if (value === null) return "0.0";
    if (value.kind === "mate") {
      return value.moves > 0 ? `M${value.moves}` : `-M${Math.abs(value.moves)}`;
    }
    const pawns = value.cp / 100;
    return pawns >= 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1);
  }

  let displayValue = $derived(formatScore(score));
  let ariaLabel = $derived(`Position evaluation: ${displayValue}`);
  let ariaValue = $derived(Math.round((whiteFraction - 0.5) * 20 * 100) / 100);
</script>

{#if visible}
  <div
    class="eval-bar"
    title={displayValue}
    role="meter"
    aria-valuenow={ariaValue}
    aria-valuemin={-10}
    aria-valuemax={10}
    aria-label={ariaLabel}
  >
    <div class="eval-black" style="height: {100 - whiteHeight}%">
      {#if 100 - whiteHeight > 15}
        <span class="side-label">B</span>
      {/if}
      {#if whiteHeight < 50}
        <span class="eval-label">{displayValue}</span>
      {/if}
    </div>
    <div class="eval-white" style="height: {whiteHeight}%">
      {#if whiteHeight >= 50}
        <span class="eval-label">{displayValue}</span>
      {/if}
      {#if whiteHeight > 15}
        <span class="side-label">W</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .eval-bar {
    width: 28px;
    height: min(80vh, 560px);
    display: flex;
    flex-direction: column;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid var(--cm-border-medium);
    font-size: 11px;
    font-weight: 600;
    user-select: none;
  }

  .eval-black {
    background: var(--cm-eval-bar-black);
    color: var(--cm-text-inverse);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    transition: height 0.3s ease;
  }

  .eval-white {
    background: var(--cm-board-light);
    color: var(--cm-text-primary);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    transition: height 0.3s ease;
  }

  .eval-label {
    padding: 2px 0;
    writing-mode: vertical-lr;
    text-orientation: mixed;
    font-family: var(--cm-font-mono);
    max-height: 100%;
    overflow: hidden;
  }

  .side-label {
    font-size: 9px;
    font-weight: 600;
    opacity: 0.6;
    writing-mode: vertical-lr;
    text-orientation: mixed;
    user-select: none;
  }
</style>
