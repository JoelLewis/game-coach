<script module lang="ts">
  import type { Severity } from "./severity";

  export type MoveListItem = {
    ply: number;
    san: string;
    severity?: Severity;
  };
</script>

<script lang="ts">
  import SeverityChip from "./SeverityChip.svelte";

  type MoveRow = {
    number: number;
    white?: MoveListItem;
    black?: MoveListItem;
  };

  type Props = {
    moves: MoveListItem[];
    currentPly: number | null;
    onSelect: (ply: number) => void;
  };

  let { moves, currentPly, onSelect }: Props = $props();

  let rows = $derived.by((): MoveRow[] => {
    const byNumber = new Map<number, MoveRow>();
    for (const move of moves) {
      const number = Math.ceil(move.ply / 2);
      const row = byNumber.get(number) ?? { number };
      if (move.ply % 2 === 1) {
        row.white = move;
      } else {
        row.black = move;
      }
      byNumber.set(number, row);
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  });

  let sortedPlies = $derived([...moves].map((move) => move.ply).sort((a, b) => a - b));

  let listEl: HTMLDivElement;

  // Auto-scroll to the bottom as new moves are appended.
  $effect(() => {
    if (listEl && moves.length > 0) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  });

  function focusPly(ply: number | undefined): void {
    if (ply === undefined) return;
    listEl?.querySelector<HTMLButtonElement>(`[data-ply="${ply}"]`)?.focus();
  }

  function handleKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    const current = Number(target.dataset["ply"]);
    if (Number.isNaN(current)) return;

    const index = sortedPlies.indexOf(current);
    if (index === -1) return;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusPly(sortedPlies[Math.min(index + 1, sortedPlies.length - 1)]);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusPly(sortedPlies[Math.max(index - 1, 0)]);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusPly(sortedPlies[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focusPly(sortedPlies[sortedPlies.length - 1]);
    }
  }

  function tabIndexFor(ply: number): number {
    const rovingPly = currentPly ?? sortedPlies[0];
    return ply === rovingPly ? 0 : -1;
  }
</script>

<div
  bind:this={listEl}
  class="move-list"
  role="listbox"
  aria-label="Move list"
  tabindex="-1"
  onkeydown={handleKeydown}
>
  {#each rows as row (row.number)}
    <div class="move-row">
      <span class="move-number">{row.number}.</span>
      {#if row.white}
        <button
          type="button"
          role="option"
          class="move"
          class:active={currentPly === row.white.ply}
          aria-selected={currentPly === row.white.ply}
          data-ply={row.white.ply}
          tabindex={tabIndexFor(row.white.ply)}
          onclick={() => onSelect(row.white!.ply)}
        >
          <span class="san">{row.white.san}</span>
          {#if row.white.severity !== undefined}
            <SeverityChip severity={row.white.severity} />
          {/if}
        </button>
      {/if}
      {#if row.black}
        <button
          type="button"
          role="option"
          class="move"
          class:active={currentPly === row.black.ply}
          aria-selected={currentPly === row.black.ply}
          data-ply={row.black.ply}
          tabindex={tabIndexFor(row.black.ply)}
          onclick={() => onSelect(row.black!.ply)}
        >
          <span class="san">{row.black.san}</span>
          {#if row.black.severity !== undefined}
            <SeverityChip severity={row.black.severity} />
          {/if}
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .move-list {
    overflow-y: auto;
    max-height: 400px;
    padding: var(--cm-space-2);
    font-family: var(--cm-font-mono);
    font-size: var(--cm-text-base);
  }

  .move-row {
    display: flex;
    align-items: center;
    gap: var(--cm-space-1);
    padding: 2px 0;
  }

  .move-number {
    color: var(--cm-text-muted);
    min-width: 32px;
    text-align: right;
  }

  .move {
    display: inline-flex;
    align-items: center;
    gap: var(--cm-space-1);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--cm-radius-sm);
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    min-width: 50px;
    text-align: left;
  }

  .move:hover {
    background: var(--cm-border-default);
  }

  .move.active {
    background: var(--cm-accent-secondary-muted);
    font-weight: 600;
  }
</style>
