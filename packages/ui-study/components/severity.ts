// Coaching move severity, shared by SeverityChip and MoveList.
// 0 is the mildest classification (a fine move), 3 the harshest (a blunder).
export type Severity = 0 | 1 | 2 | 3;

export const SEVERITY_LABELS: Record<Severity, string> = {
  0: "Fine",
  1: "Inaccuracy",
  2: "Mistake",
  3: "Blunder",
};

// Each severity maps to one of "The Study" design system's four status
// tokens so severity chips stay in sync with theme changes automatically.
export const SEVERITY_TOKENS: Record<Severity, string> = {
  0: "var(--cm-status-success)",
  1: "var(--cm-status-info)",
  2: "var(--cm-status-warning)",
  3: "var(--cm-status-error)",
};
