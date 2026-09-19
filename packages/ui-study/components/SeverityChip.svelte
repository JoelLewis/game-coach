<script lang="ts">
  import { SEVERITY_LABELS, SEVERITY_TOKENS } from "./severity";
  import type { Severity } from "./severity";

  type Props = {
    severity: Severity;
  };

  let { severity }: Props = $props();

  const label = $derived(SEVERITY_LABELS[severity]);
  const color = $derived(SEVERITY_TOKENS[severity]);
</script>

<span class="severity-chip" data-severity={severity} style:--chip-color={color}>
  {label}
</span>

<style>
  .severity-chip {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--cm-space-2);
    border-radius: var(--cm-radius-full);
    font-family: var(--cm-font-mono);
    font-size: var(--cm-text-xs);
    font-weight: 600;
    line-height: 1.6;
    color: var(--chip-color);
    background: color-mix(in srgb, var(--chip-color) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--chip-color) 40%, transparent);
    white-space: nowrap;
  }
</style>
