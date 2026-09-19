<script lang="ts">
  import { Chessground } from "@lichess-org/chessground";
  import { untrack } from "svelte";
  import type { Api } from "@lichess-org/chessground/api";
  import type { Key } from "@lichess-org/chessground/types";
  import "@lichess-org/chessground/assets/chessground.base.css";
  import { sanToSquares, uciToSquares } from "../chess-notation.ts";

  type Props = {
    fen: string;
    playedUci: string;
    bestSan: string | null;
    orientation: "white" | "black";
  };

  const { fen, playedUci, bestSan, orientation }: Props = $props();

  let boardEl: HTMLDivElement;
  let cg: Api | undefined;

  const played = $derived(uciToSquares(playedUci));
  const best = $derived(bestSan ? sanToSquares(fen, bestSan) : null);

  const autoShapes = $derived(() => {
    const shapes: { orig: Key; dest: Key; brush: string }[] = [];
    if (best && (!played || best.from !== played.from || best.to !== played.to)) {
      shapes.push({ orig: best.from as Key, dest: best.to as Key, brush: "paleBlue" });
    }
    if (played) {
      shapes.push({ orig: played.from as Key, dest: played.to as Key, brush: "green" });
    }
    return shapes;
  });

  // Built as a function, not an object literal with `undefined` fallbacks:
  // `exactOptionalPropertyTypes` treats an explicit `undefined` differently
  // from an omitted key, and chessground's own Config only allows the latter.
  type SetConfig = Parameters<Api["set"]>[0];
  const buildConfig = (currentFen: string, shapes: { orig: Key; dest: Key; brush: string }[]): SetConfig => {
    const config: SetConfig = {
      fen: currentFen,
      orientation,
      drawable: { visible: true, enabled: false, autoShapes: shapes },
    };
    if (played) config.lastMove = [played.from as Key, played.to as Key];
    return config;
  };

  $effect(() => {
    const currentFen = fen;
    const shapes = autoShapes();
    const config = buildConfig(currentFen, shapes);

    if (!cg) {
      cg = untrack(() =>
        Chessground(boardEl, { ...config, viewOnly: true, coordinates: true, movable: { free: false } }),
      );
      return;
    }
    cg.set(config);
  });

  $effect(() => () => cg?.destroy());
</script>

<figure class="board-frame" aria-label="Board preview: played move in green, engine's best move in blue">
  <div class="board" bind:this={boardEl}></div>
  <figcaption class="legend">
    <span class="swatch played"></span> played
    <span class="swatch best"></span> engine best
  </figcaption>
</figure>

<style>
  .board-frame {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .board {
    width: 100%;
    aspect-ratio: 1;
    max-width: 480px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
    box-shadow: var(--shadow-md);
  }

  .legend {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.03em;
    color: var(--ink-faint);
    text-transform: uppercase;
  }

  .legend .swatch {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
    display: inline-block;
    margin-left: 0.75rem;
  }

  .legend .swatch:first-child {
    margin-left: 0;
  }

  .swatch.played {
    background: var(--accent-good);
  }

  .swatch.best {
    background: var(--accent-info);
  }
</style>
