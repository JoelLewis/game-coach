// The one piece of mutable state in the app: which item is open, its editable
// draft label, and save/nav plumbing. Kept out of App.svelte so the keyboard
// layer, the components, and tests can all drive it the same way.
import type { CalibrationItem, CalibrationLabel } from "@game-coach/contracts/calibration";
import { fetchItems, putLabel } from "./api.ts";
import { consistencyWarnings, type ConsistencyWarning } from "./consistency.ts";
import type { LabelAction } from "./keymap.ts";
import { clampIndex, computeProgress, firstUnlabeledIndex, type Progress } from "./progress.ts";

const blankLabel = (): CalibrationLabel => ({
  severity: 0,
  errorClass: "unclear",
  interruptWorthy: false,
  teachable: false,
  goodMove: false,
  missedTactic: false,
  note: "",
});

const draftFrom = (item: CalibrationItem | undefined): CalibrationLabel => {
  const source = item?.label ?? item?.proposed ?? null;
  return source ? { ...source, note: source.note ?? "" } : blankLabel();
};

export class LabelingSession {
  items = $state<CalibrationItem[]>([]);
  index = $state(0);
  draft = $state<CalibrationLabel>(blankLabel());
  loading = $state(true);
  saving = $state(false);
  error = $state<string | null>(null);
  helpVisible = $state(false);
  // Bumped whenever the UI should move focus into the note field.
  noteFocusToken = $state(0);

  current: CalibrationItem | null = $derived(this.items[this.index] ?? null);
  warnings: ConsistencyWarning[] = $derived(consistencyWarnings(this.draft));
  progress: Progress = $derived(computeProgress(this.items));
  isProposalUnedited: boolean = $derived(
    this.current?.proposed !== null &&
      this.current?.proposed !== undefined &&
      labelsEqual(this.draft, this.current.proposed),
  );

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const items = await fetchItems();
      this.items = items;
      this.goTo(firstUnlabeledIndex(items));
    } catch (cause) {
      this.error = messageOf(cause);
    } finally {
      this.loading = false;
    }
  }

  goTo(index: number): void {
    if (this.items.length === 0) {
      this.index = 0;
      this.draft = blankLabel();
      return;
    }
    this.index = clampIndex(index, this.items.length);
    this.draft = draftFrom(this.items[this.index]);
  }

  setSeverity(severity: 0 | 1 | 2 | 3): void {
    this.draft = { ...this.draft, severity };
  }

  setErrorClass(errorClass: CalibrationLabel["errorClass"]): void {
    this.draft = { ...this.draft, errorClass };
  }

  toggle(field: "interruptWorthy" | "teachable" | "goodMove" | "missedTactic"): void {
    this.draft = { ...this.draft, [field]: !this.draft[field] };
  }

  setNote(note: string): void {
    this.draft = { ...this.draft, note };
  }

  toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
  }

  requestNoteFocus(): void {
    this.noteFocusToken += 1;
  }

  /** Dispatch a resolved keymap action. Returns the in-flight save, if any, so callers can await it in tests. */
  apply(action: LabelAction): Promise<void> | void {
    switch (action.kind) {
      case "severity":
        return this.setSeverity(action.severity);
      case "errorClass":
        return this.setErrorClass(action.errorClass);
      case "toggle":
        return this.toggle(action.field);
      case "advance":
        return this.commit(1);
      case "back":
        return this.commit(-1);
      case "focusNote":
        return this.requestNoteFocus();
      case "help":
        return this.toggleHelp();
    }
  }

  async commit(direction: 1 | -1): Promise<void> {
    const item = this.current;
    if (!item) return;
    this.saving = true;
    this.error = null;
    try {
      const updated = await putLabel(item.id, this.draft);
      const items = this.items.slice();
      items[this.index] = updated;
      this.items = items;
      this.goTo(this.index + direction);
    } catch (cause) {
      this.error = messageOf(cause);
    } finally {
      this.saving = false;
    }
  }
}

const labelsEqual = (a: CalibrationLabel, b: CalibrationLabel): boolean =>
  a.severity === b.severity &&
  a.errorClass === b.errorClass &&
  a.interruptWorthy === b.interruptWorthy &&
  a.teachable === b.teachable &&
  a.goodMove === b.goodMove &&
  a.missedTactic === b.missedTactic &&
  (a.note ?? "") === (b.note ?? "");

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
