// Single source of truth for the labeler's keymap: the same list drives key
// resolution, the on-screen hint chips, and the help overlay, so they can
// never drift out of sync with each other.
import { ERROR_CLASS_IDS, SEVERITY_LEVELS, type ErrorClass } from "@game-coach/contracts/taxonomy";

export type ToggleField = "interruptWorthy" | "teachable" | "goodMove" | "missedTactic";

export type LabelAction =
  | { kind: "severity"; severity: 0 | 1 | 2 | 3 }
  | { kind: "errorClass"; errorClass: ErrorClass }
  | { kind: "toggle"; field: ToggleField }
  | { kind: "advance" }
  | { kind: "back" }
  | { kind: "focusNote" }
  | { kind: "help" };

export type KeyHint = {
  key: string;
  displayKey: string;
  description: string;
  group: "severity" | "errorClass" | "flag" | "nav" | "other";
  action: LabelAction;
};

const SEVERITY_KEYS = ["1", "2", "3", "4"] as const;
const ERROR_CLASS_KEYS = ["q", "w", "e", "r", "t", "y", "u"] as const;

const severityHints: KeyHint[] = SEVERITY_KEYS.map((key, index) => ({
  key,
  displayKey: key,
  description: SEVERITY_LEVELS[index] ?? key,
  group: "severity",
  action: { kind: "severity", severity: index as 0 | 1 | 2 | 3 },
}));

const errorClassHints: KeyHint[] = ERROR_CLASS_KEYS.map((key, index) => {
  const errorClass = ERROR_CLASS_IDS[index];
  if (!errorClass) throw new Error(`No error class for key ${key}`);
  return {
    key,
    displayKey: key.toUpperCase(),
    description: errorClass,
    group: "errorClass",
    action: { kind: "errorClass", errorClass },
  };
});

export const KEY_HINTS: readonly KeyHint[] = [
  ...severityHints,
  ...errorClassHints,
  { key: "i", displayKey: "I", description: "interrupt-worthy", group: "flag", action: { kind: "toggle", field: "interruptWorthy" } },
  { key: "x", displayKey: "X", description: "teachable", group: "flag", action: { kind: "toggle", field: "teachable" } },
  { key: "g", displayKey: "G", description: "good move", group: "flag", action: { kind: "toggle", field: "goodMove" } },
  { key: "m", displayKey: "M", description: "missed tactic", group: "flag", action: { kind: "toggle", field: "missedTactic" } },
  { key: "n", displayKey: "N", description: "focus note", group: "other", action: { kind: "focusNote" } },
  { key: "enter", displayKey: "Enter", description: "accept & next", group: "nav", action: { kind: "advance" } },
  { key: "backspace", displayKey: "⌫", description: "save & previous", group: "nav", action: { kind: "back" } },
  { key: "?", displayKey: "?", description: "help", group: "other", action: { kind: "help" } },
];

const HINTS_BY_KEY = new Map(KEY_HINTS.map((hint) => [hint.key, hint]));

/** Resolve a raw `KeyboardEvent.key` value to the action it triggers, or null if unmapped. */
export const resolveKey = (rawKey: string): LabelAction | null => {
  const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey.toLowerCase();
  return HINTS_BY_KEY.get(key)?.action ?? null;
};

