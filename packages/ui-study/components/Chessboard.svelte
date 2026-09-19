<script module lang="ts">
  export type PromotionRole = "queen" | "rook" | "bishop" | "knight";
</script>

<script lang="ts">
  import { Chessground } from "@lichess-org/chessground";
  import { untrack } from "svelte";
  import type { Api } from "@lichess-org/chessground/api";
  import type { Dests, Key, Piece } from "@lichess-org/chessground/types";
  import "@lichess-org/chessground/assets/chessground.base.css";

  type Color = "white" | "black";

  const PROMOTION_ROLES: readonly PromotionRole[] = ["queen", "rook", "bishop", "knight"];

  type Props = {
    fen?: string;
    orientation?: Color;
    turnColor?: Color;
    dests?: Map<string, string[]>;
    viewOnly?: boolean;
    lastMove?: [string, string] | null;
    isCheck?: boolean;
    // Squares to ring for a coaching event (e.g. the square a player should
    // have noticed). Drawn as chessground auto-shapes.
    highlights?: string[];
    onMove?: (from: string, to: string, promotion?: PromotionRole) => void;
  };

  let {
    fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    orientation = "white",
    turnColor = "white",
    dests = new Map(),
    viewOnly = false,
    lastMove = null,
    isCheck = false,
    highlights = [],
    onMove,
  }: Props = $props();

  let boardEl: HTMLDivElement;
  let containerEl: HTMLDivElement;
  let cg: Api | undefined = $state();

  type PendingPromotion = { from: Key; to: Key; color: Color };
  let pendingPromotion = $state<PendingPromotion | null>(null);

  function toDests(source: Map<string, string[]>): Dests {
    const map: Dests = new Map();
    for (const [from, tos] of source) {
      map.set(from as Key, tos as Key[]);
    }
    return map;
  }

  function toAutoShapes(squares: string[]) {
    return squares.map((square) => ({ orig: square as Key, brush: "yellow" as const }));
  }

  type SetConfig = Parameters<Api["set"]>[0];

  // Built as a function (rather than an object literal with `undefined`
  // fallbacks) because `exactOptionalPropertyTypes` treats an explicit
  // `undefined` differently from an omitted key — chessground's own types
  // only allow the latter for `movable.color` and `lastMove`.
  function buildSetConfig(): SetConfig {
    const movable: NonNullable<SetConfig["movable"]> = { dests: toDests(dests) };
    if (!viewOnly) {
      movable.color = turnColor;
    }

    const config: SetConfig = {
      fen,
      orientation,
      turnColor,
      viewOnly,
      check: isCheck,
      movable,
      drawable: { visible: true, autoShapes: toAutoShapes(highlights) },
    };

    if (lastMove) {
      config.lastMove = lastMove as [Key, Key];
    }

    return config;
  }

  function isLastRank(key: Key, color: Color): boolean {
    const rank = key[1];
    return (color === "white" && rank === "8") || (color === "black" && rank === "1");
  }

  // Chessground has already applied the move to its own piece map by the
  // time `events.move` fires, so the piece at `dest` reflects the move that
  // just happened.
  function handleMove(orig: Key, dest: Key): void {
    const piece = cg?.state.pieces.get(dest);
    if (piece?.role === "pawn" && isLastRank(dest, piece.color)) {
      pendingPromotion = { from: orig, to: dest, color: piece.color };
      return;
    }
    onMove?.(orig, dest);
  }

  function confirmPromotion(role: PromotionRole): void {
    if (!pendingPromotion) return;
    const { from, to, color } = pendingPromotion;
    const promoted: Piece = { role, color };
    cg?.setPieces(new Map([[to, promoted]]));
    pendingPromotion = null;
    onMove?.(from, to, role);
  }

  function cancelPromotion(): void {
    if (!pendingPromotion) return;
    pendingPromotion = null;
    // The caller was never told about this move (onMove was not called), so
    // the pre-move `fen` prop is still authoritative. Replaying it snaps
    // chessground's optimistic visual move back to the real position —
    // defaulting to queen instead would silently make a move the player
    // never chose.
    cg?.set({ fen });
  }

  function handlePromotionKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelPromotion();
    }
  }

  let promotionPickerEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (pendingPromotion && promotionPickerEl) {
      promotionPickerEl.querySelector<HTMLButtonElement>(".promotion-choice")?.focus();
    }
  });

  // Mount chessground — recreated only when viewOnly changes, since chessground
  // binds pointer and bounds-invalidation listeners at construction and skips
  // them all under viewOnly (set() never rebinds). Other prop changes sync via
  // the effect below without recreating.
  $effect(() => {
    if (!boardEl) return;
    const view = viewOnly;

    const instance = untrack(() =>
      Chessground(boardEl, {
        fen,
        orientation,
        turnColor,
        viewOnly: view,
        movable: {
          free: false,
          color: turnColor,
          dests: toDests(dests),
          showDests: true,
        },
        highlight: {
          lastMove: true,
          check: true,
        },
        animation: {
          enabled: true,
          duration: 200,
        },
        draggable: {
          enabled: true,
          showGhost: true,
        },
        drawable: {
          visible: true,
          autoShapes: toAutoShapes(highlights),
        },
        events: {
          move: handleMove,
        },
      }),
    );
    cg = instance;

    // Chessground caches the board's screen position and only refreshes it
    // when the board element itself resizes — a board that *moves* (sidebar
    // collapse, window resize, panel changes) hit-tests against stale
    // coordinates. Clear the cache right before chessground handles the
    // event: capture phase on the container runs first.
    const refreshBounds = () => instance.state.dom.bounds.clear();
    containerEl.addEventListener("mousedown", refreshBounds, { capture: true });
    containerEl.addEventListener("touchstart", refreshBounds, { capture: true, passive: true });

    return () => {
      containerEl.removeEventListener("mousedown", refreshBounds, { capture: true });
      containerEl.removeEventListener("touchstart", refreshBounds, { capture: true });
      instance.destroy();
      cg = undefined;
    };
  });

  // Sync props to chessground when they change (without recreating)
  $effect(() => {
    if (!cg) return;

    cg.set(buildSetConfig());
  });
</script>

<div
  bind:this={containerEl}
  class="board-container"
  role="img"
  aria-label="Chess board — position: {fen ?? 'starting position'}"
>
  <div bind:this={boardEl} class="board"></div>

  {#if pendingPromotion}
    <!--
      Escape-to-cancel on a widget's own container is a standard accessible
      pattern (WAI-ARIA popup/menu dismissal); the group itself stays
      non-interactive and focus lives on its buttons.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={promotionPickerEl}
      class="promotion-picker"
      role="group"
      aria-label="Choose promotion piece"
      onkeydown={handlePromotionKeydown}
    >
      {#each PROMOTION_ROLES as role (role)}
        <button
          type="button"
          class="promotion-choice"
          aria-label={`Promote to ${role}`}
          onclick={() => confirmPromotion(role)}
        >
          {role}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .board-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  .board {
    width: min(80vh, 560px);
    height: min(80vh, 560px);
  }

  .promotion-picker {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    gap: var(--cm-space-2);
    padding: var(--cm-space-3);
    background: var(--cm-bg-surface);
    border: 1px solid var(--cm-border-medium);
    border-radius: var(--cm-radius-md);
    box-shadow: var(--cm-shadow-lg);
    z-index: 10;
  }

  .promotion-choice {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: var(--cm-radius-sm);
    border: 1px solid var(--cm-border-default);
    background: var(--cm-bg-surface-alt);
    cursor: pointer;
    font-family: var(--cm-font-mono);
    font-size: var(--cm-text-sm);
    text-transform: capitalize;
    color: var(--cm-text-primary);
  }

  .promotion-choice:hover,
  .promotion-choice:focus-visible {
    background: var(--cm-accent-primary-bg);
    border-color: var(--cm-accent-primary);
  }
</style>
