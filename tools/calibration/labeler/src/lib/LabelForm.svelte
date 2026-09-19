<script lang="ts">
  import { SEVERITY_LEVELS } from "@game-coach/contracts/taxonomy";
  import type { CalibrationLabel } from "@game-coach/contracts/calibration";
  import type { ConsistencyWarning } from "../consistency.ts";
  import { KEY_HINTS, type ToggleField } from "../keymap.ts";
  import KeyHintChip from "./KeyHintChip.svelte";

  type Props = {
    draft: CalibrationLabel;
    warnings: ConsistencyWarning[];
    isProposal: boolean;
    proposalNote?: string | undefined;
    noteFocusToken: number;
    onSeverity: (severity: 0 | 1 | 2 | 3) => void;
    onErrorClass: (errorClass: CalibrationLabel["errorClass"]) => void;
    onToggle: (field: ToggleField) => void;
    onNote: (note: string) => void;
  };

  const { draft, warnings, isProposal, proposalNote, noteFocusToken, onSeverity, onErrorClass, onToggle, onNote }: Props = $props();

  const severityHints = KEY_HINTS.filter((hint) => hint.group === "severity");
  const errorClassHints = KEY_HINTS.filter((hint) => hint.group === "errorClass");

  const SEVERITY_COLORS = ["var(--sev-0)", "var(--sev-1)", "var(--sev-2)", "var(--sev-3)"] as const;

  let noteInput: HTMLInputElement | undefined = $state();

  $effect(() => {
    // Any change to the token (even the initial 0 -> the first real bump) means
    // "focus the note field now", so `n` works from anywhere on the page.
    if (noteFocusToken > 0) noteInput?.focus();
  });
</script>

<section class="label-form" aria-label="Label">
  {#if isProposal}
    <div class="stamp" role="status">
      <span>proposal</span>
      {#if proposalNote}<p class="rationale">{proposalNote}</p>{/if}
    </div>
  {/if}

  <fieldset>
    <legend>severity</legend>
    <div class="chip-row">
      {#each severityHints as hint, index (hint.key)}
        <KeyHintChip
          displayKey={hint.displayKey}
          label={SEVERITY_LEVELS[index] ?? hint.description}
          active={draft.severity === index}
          color={SEVERITY_COLORS[index] ?? null}
          onclick={() => onSeverity(index as 0 | 1 | 2 | 3)}
        />
      {/each}
    </div>
  </fieldset>

  <fieldset>
    <legend>error class</legend>
    <div class="chip-row">
      {#each errorClassHints as hint (hint.key)}
        {#if hint.action.kind === "errorClass"}
          {@const errorClass = hint.action.errorClass}
          <KeyHintChip
            displayKey={hint.displayKey}
            label={errorClass.replace(/_/g, " ")}
            active={draft.errorClass === errorClass}
            onclick={() => onErrorClass(errorClass)}
          />
        {/if}
      {/each}
    </div>
  </fieldset>

  <fieldset>
    <legend>flags</legend>
    <div class="chip-row">
      <KeyHintChip displayKey="I" label="interrupt-worthy" active={draft.interruptWorthy} onclick={() => onToggle("interruptWorthy")} />
      <KeyHintChip displayKey="X" label="teachable" active={draft.teachable} onclick={() => onToggle("teachable")} />
      <KeyHintChip displayKey="G" label="good move" active={draft.goodMove} onclick={() => onToggle("goodMove")} />
      <KeyHintChip displayKey="M" label="missed tactic" active={draft.missedTactic} onclick={() => onToggle("missedTactic")} />
    </div>
  </fieldset>

  {#if warnings.length > 0}
    <ul class="warnings" role="alert">
      {#each warnings as warning (warning.id)}
        <li>{warning.message}</li>
      {/each}
    </ul>
  {/if}

  <label class="note-field">
    <span class="cell-label">note <kbd class="mono">n</kbd></span>
    <input
      type="text"
      maxlength="500"
      bind:this={noteInput}
      value={draft.note ?? ""}
      oninput={(event) => onNote(event.currentTarget.value)}
      placeholder="Optional — why this label"
    />
  </label>
</section>

<style>
  .label-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .stamp {
    align-self: flex-start;
    padding: 0.3rem 0.9rem;
    border: 2px dashed var(--accent-proposal);
    border-radius: var(--radius-sm);
    color: var(--accent-proposal);
    background: var(--accent-proposal-bg);
    transform: rotate(-1.5deg);
    font-family: var(--font-display);
    font-style: italic;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.8rem;
  }

  .rationale {
    margin: 0.35rem 0 0;
    font-family: var(--font-body);
    font-style: normal;
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.82rem;
    color: var(--ink-dim);
    max-width: 42ch;
  }

  fieldset {
    border: none;
    padding: 0;
    margin: 0;
  }

  legend {
    padding: 0;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-faint);
    margin-bottom: 0.4rem;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .warnings {
    margin: 0;
    padding: 0.6rem 0.8rem;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    background: color-mix(in oklch, var(--accent-warning) 12%, var(--surface));
    border-left: 3px solid var(--accent-warning);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-size: 0.82rem;
    color: var(--ink);
  }

  .note-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .cell-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-faint);
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .cell-label kbd {
    padding: 0.02rem 0.28rem;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
  }

  input[type="text"] {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    color: var(--ink);
    padding: 0.5rem 0.65rem;
    font-size: 0.88rem;
  }

  input[type="text"]:focus-visible {
    outline: 2px solid var(--accent-info);
    outline-offset: 1px;
  }
</style>
