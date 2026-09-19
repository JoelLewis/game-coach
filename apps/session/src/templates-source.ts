// Loads the template library and theme list from KV, caching in DO memory (losing the cache
// on hibernation just means one extra KV read, never a correctness issue). Falls back to the
// bundled library when KV has nothing published yet, or when the published JSON fails to parse.
import * as v from "valibot";
import { kvKeys } from "@game-coach/contracts/storage";
import { TemplateLibrarySchema, type TemplateLibrary } from "@game-coach/contracts/templates";
import { CHESS_THEMES } from "@game-coach/contracts/taxonomy";
import type { GameKind } from "@game-coach/contracts/engine";
import { FALLBACK_TEMPLATE_LIBRARY } from "./fallback-templates.ts";

export type ThemeMap = Readonly<Record<string, string>>;

export type TemplatesSource = {
  getLibrary(game: GameKind): Promise<TemplateLibrary>;
  getThemes(game: GameKind): Promise<ThemeMap>;
};

// kvKeys.active's documented shape is `{ templates: n, themes: n, thresholds: n }`; read
// defensively since the value is operator-published JSON, not schema-validated at rest.
type ActiveVersions = { templates: number | undefined; themes: number | undefined };

const readActiveVersions = async (kv: KVNamespace): Promise<ActiveVersions> => {
  const raw = await kv.get(kvKeys.active, "json");
  if (typeof raw !== "object" || raw === null) return { templates: undefined, themes: undefined };
  const { templates, themes } = raw as Record<string, unknown>;
  return {
    templates: typeof templates === "number" ? templates : undefined,
    themes: typeof themes === "number" ? themes : undefined,
  };
};

export const createTemplatesSource = (kv: KVNamespace): TemplatesSource => {
  let library: TemplateLibrary | undefined;
  let themes: ThemeMap | undefined;

  return {
    async getLibrary(game) {
      if (library !== undefined) return library;
      const active = await readActiveVersions(kv);
      if (active.templates !== undefined) {
        const raw = await kv.get(kvKeys.templates(active.templates, game), "json");
        if (raw !== null) {
          try {
            library = v.parse(TemplateLibrarySchema, raw);
            return library;
          } catch {
            // Fall through to the bundled library below; a bad publish must never break play.
          }
        }
      }
      library = FALLBACK_TEMPLATE_LIBRARY;
      return library;
    },

    async getThemes(_game) {
      if (themes !== undefined) return themes;
      const active = await readActiveVersions(kv);
      if (active.themes !== undefined) {
        const raw = await kv.get(kvKeys.themes(active.themes, _game), "json");
        if (raw !== null && typeof raw === "object") {
          const entries = Object.entries(raw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          );
          if (entries.length > 0) {
            themes = Object.fromEntries(entries);
            return themes;
          }
        }
      }
      themes = CHESS_THEMES;
      return themes;
    },
  };
};
