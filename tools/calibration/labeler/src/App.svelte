<script lang="ts">
  import { onMount } from "svelte";
  import { sideToMove } from "./chess-notation.ts";
  import { resolveKey } from "./keymap.ts";
  import { LabelingSession } from "./session.svelte.ts";
  import BoardPreview from "./lib/BoardPreview.svelte";
  import FactsPanel from "./lib/FactsPanel.svelte";
  import HelpOverlay from "./lib/HelpOverlay.svelte";
  import KeyHintChip from "./lib/KeyHintChip.svelte";
  import LabelForm from "./lib/LabelForm.svelte";
  import ProgressBar from "./lib/ProgressBar.svelte";

  const session = new LabelingSession();
  onMount(() => {
    void session.load();
  });

  const orientation = $derived(session.current ? sideToMove(session.current.facts.positionBefore) : "white");
  const bestSan = $derived(session.current?.facts.bestLines[0]?.line[0] ?? null);

  const isEditableField = (target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

  const handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (session.helpVisible) return; // the overlay owns the keyboard while it's open

    if (isEditableField(event.target)) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.target.blur();
        void session.commit(1);
      } else if (event.key === "Escape") {
        event.target.blur();
      }
      return;
    }

    const action = resolveKey(event.key);
    if (!action) return;
    event.preventDefault();
    void session.apply(action);
  };
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="app">
  <header>
    <h1>Calibration<span class="dot">.</span></h1>
    <div class="header-progress">
      <ProgressBar progress={session.progress} currentPosition={session.items.length === 0 ? 0 : session.index + 1} />
    </div>
    <KeyHintChip displayKey="?" label="help" onclick={() => session.toggleHelp()} />
  </header>

  {#if session.loading}
    <p class="status">Loading items&hellip;</p>
  {:else if session.error && !session.current}
    <p class="status error">{session.error}</p>
  {:else if session.current}
    {@const item = session.current}
    <main>
      <section class="board-col">
        <BoardPreview fen={item.facts.positionBefore} playedUci={item.facts.moveId} {bestSan} {orientation} />
        <div class="nav-row">
          <KeyHintChip displayKey="⌫" label="save & previous" onclick={() => session.commit(-1)} />
          <KeyHintChip displayKey="Enter" label="accept & next" onclick={() => session.commit(1)} />
        </div>
        {#if session.saving}<p class="hint">saving&hellip;</p>{/if}
        {#if session.error}<p class="hint error">{session.error}</p>{/if}
      </section>

      <section class="facts-col">
        <FactsPanel facts={item.facts} ratingBand={item.ratingBand} />
      </section>

      <section class="label-col">
        <LabelForm
          draft={session.draft}
          warnings={session.warnings}
          isProposal={session.isProposalUnedited}
          proposalNote={item.proposed?.note}
          noteFocusToken={session.noteFocusToken}
          onSeverity={(severity) => session.setSeverity(severity)}
          onErrorClass={(errorClass) => session.setErrorClass(errorClass)}
          onToggle={(field) => session.toggle(field)}
          onNote={(note) => session.setNote(note)}
        />
      </section>
    </main>
  {:else}
    <p class="status">This set has no items.</p>
  {/if}

  {#if session.helpVisible}
    <HelpOverlay onClose={() => session.toggleHelp()} />
  {/if}
</div>

<style>
  .app {
    max-width: 1180px;
    margin: 0 auto;
    padding: clamp(1rem, 2vw, 2rem);
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    container-type: inline-size;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  h1 {
    font-family: var(--font-display);
    font-style: italic;
    font-weight: 500;
    font-size: 1.4rem;
    margin: 0;
    color: var(--ink);
    white-space: nowrap;
  }

  h1 .dot {
    color: var(--accent-proposal);
  }

  .header-progress {
    flex: 1;
  }

  .status {
    color: var(--ink-dim);
    font-size: 0.95rem;
  }

  .status.error {
    color: var(--accent-danger);
  }

  main {
    display: grid;
    grid-template-columns: minmax(280px, 480px) minmax(260px, 1fr) minmax(280px, 380px);
    gap: clamp(1rem, 2vw, 2rem);
    align-items: start;
  }

  @container (max-width: 900px) {
    main {
      grid-template-columns: 1fr;
    }
  }

  .board-col,
  .facts-col,
  .label-col {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    padding: 1.1rem;
  }

  .nav-row {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.75rem;
  }

  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    color: var(--ink-faint);
  }

  .hint.error {
    color: var(--accent-danger);
  }
</style>
