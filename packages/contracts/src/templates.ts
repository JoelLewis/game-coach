// Coaching templates: most of what the player reads (PRD "Coaching content").
import * as v from "valibot";
import { GameKindSchema, PhaseSchema } from "./engine.ts";
import { ErrorClassSchema, SeverityLevelSchema, ThemeIdSchema } from "./taxonomy.ts";

// Slots the session fills from MoveFacts. Closed list; templates-chess lints against it.
export const SLOT_NAMES = [
  "played",
  "best_move",
  "swing",
  "piece",
  "square",
  "target_square",
  "line",
  "group",
  "liberties",
] as const;
export const SlotNameSchema = v.picklist(SLOT_NAMES);
export type SlotName = v.InferOutput<typeof SlotNameSchema>;
export type SlotValues = Partial<Record<SlotName, string>>;

export const TEMPLATE_KINDS = ["error", "praise", "neutral"] as const;

// `<kind-or-error-class>.<phase|any>.<variant>`, e.g. "tactical_oversight.middlegame.hanging_piece".
export const TemplateIdSchema = v.pipe(v.string(), v.regex(/^[a-z_]+\.[a-z_]+\.[a-z0-9_]+$/), v.maxLength(80));
export type TemplateId = v.InferOutput<typeof TemplateIdSchema>;

export const TemplateSchema = v.object({
  id: TemplateIdSchema,
  game: GameKindSchema,
  kind: v.picklist(TEMPLATE_KINDS),
  // null for praise / neutral.
  errorClass: v.nullable(ErrorClassSchema),
  phase: v.union([PhaseSchema, v.literal("any")]),
  // Severity levels this template suits; the pre-filter matches on engine cp-loss bucket.
  severities: v.array(SeverityLevelSchema),
  themeId: ThemeIdSchema,
  // True when `text` names a specific motif (a pin, a fork, a hung piece, ...) rather than only
  // the engine numbers and the move played. A template with this set may only be spoken when the
  // caller's evidence themes include `themeId` (coaching-core's selectSpokenTemplate); additive
  // and optional so every existing template keeps behaving exactly as before.
  requiresEvidence: v.optional(v.boolean(), false),
  // What Jev reads as the choice criterion. Keep under ~15 words: it is paid for on every move.
  description: v.pipe(v.string(), v.minLength(8), v.maxLength(120)),
  // Player-facing, with {slot} placeholders. Max 2 sentences.
  text: v.pipe(v.string(), v.minLength(8), v.maxLength(280)),
  slots: v.array(SlotNameSchema),
});
export type Template = v.InferOutput<typeof TemplateSchema>;

export const TemplateLibrarySchema = v.object({
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  game: GameKindSchema,
  templates: v.array(TemplateSchema),
});
export type TemplateLibrary = v.InferOutput<typeof TemplateLibrarySchema>;

export const SLOT_PATTERN = /\{([a-z_]+)\}/g;
