<script lang="ts">
  import { KEY_HINTS } from "../keymap.ts";

  type Props = { onClose: () => void };
  const { onClose }: Props = $props();

  const groups = [
    { title: "Severity", group: "severity" as const },
    { title: "Error class", group: "errorClass" as const },
    { title: "Flags", group: "flag" as const },
    { title: "Navigation", group: "nav" as const },
    { title: "Other", group: "other" as const },
  ];

  let dialogEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    dialogEl?.focus();
  });

  // A modal swallows every keystroke: nothing behind it should react while it's open.
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" || event.key === "?") {
      event.preventDefault();
      onClose();
    }
    event.stopPropagation();
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="scrim"
  role="dialog"
  aria-modal="true"
  aria-label="Keyboard shortcuts"
  tabindex="-1"
  bind:this={dialogEl}
  onkeydown={handleKeydown}
  onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}
>
  <div class="sheet">
    <header>
      <h2>Keymap</h2>
      <button type="button" class="close" onclick={onClose} aria-label="Close help">&times;</button>
    </header>
    <div class="groups">
      {#each groups as { title, group } (group)}
        <div class="group">
          <h3>{title}</h3>
          <ul>
            {#each KEY_HINTS.filter((hint) => hint.group === group) as hint (hint.key)}
              <li><kbd class="mono">{hint.displayKey}</kbd> <span>{hint.description.replace(/_/g, " ")}</span></li>
            {/each}
          </ul>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(0% 0 0 / 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .sheet {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    padding: 1.5rem 1.75rem;
    max-width: 640px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  }

  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  h2 {
    font-family: var(--font-display);
    font-style: italic;
    font-weight: 600;
    margin: 0;
    color: var(--ink);
  }

  .close {
    background: none;
    border: none;
    font-size: 1.4rem;
    color: var(--ink-faint);
    cursor: pointer;
    line-height: 1;
  }

  .groups {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1.25rem;
  }

  .group h3 {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-faint);
    margin: 0 0 0.5rem;
  }

  .group ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .group li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--ink-dim);
    text-transform: capitalize;
  }

  kbd {
    min-width: 1.6em;
    text-align: center;
    padding: 0.1rem 0.35rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    font-size: 0.75rem;
    color: var(--ink);
    text-transform: none;
  }
</style>
