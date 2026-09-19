<script lang="ts">
  type Props = {
    displayKey: string;
    label: string;
    active?: boolean;
    color?: string | null;
    onclick: () => void;
  };

  const { displayKey, label, active = false, color = null, onclick }: Props = $props();
</script>

<button
  type="button"
  class="chip"
  class:active
  style:--chip-color={color}
  aria-pressed={active}
  {onclick}
>
  <kbd class="key mono">{displayKey}</kbd>
  <span class="label">{label}</span>
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.32rem 0.6rem 0.32rem 0.4rem;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    transition: border-color 120ms ease-out, background-color 120ms ease-out, transform 80ms ease-out;
  }

  .chip:hover {
    border-color: var(--border);
  }

  .chip:active {
    transform: translateY(1px);
  }

  .chip:focus-visible {
    outline: 2px solid var(--accent-info);
    outline-offset: 1px;
  }

  .chip.active {
    background: color-mix(in oklch, var(--chip-color, var(--accent-proposal)) 20%, var(--surface));
    border-color: var(--chip-color, var(--accent-proposal));
  }

  .key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.3em;
    padding: 0.05rem 0.3rem;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--ink-dim);
    background: var(--bg);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
  }

  .chip.active .key {
    color: var(--chip-color, var(--accent-proposal));
    border-color: currentColor;
  }

  .label {
    font-size: 0.82rem;
    color: var(--ink-dim);
    white-space: nowrap;
  }

  .chip.active .label {
    color: var(--ink);
  }
</style>
