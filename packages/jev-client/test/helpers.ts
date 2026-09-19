import { buildQuestionSet } from "@game-coach/contracts/questions";
import { CHESS_THEMES } from "@game-coach/contracts/taxonomy";
import { JevResponseSchema, type JevRequest } from "@game-coach/contracts/jev";
import * as v from "valibot";
import narrow from "../fixtures/m0/narrow.json";

export const request = (swing = 0): JevRequest => ({
  state: { engine: { swing }, game: { phase: "opening" } },
  questions: buildQuestionSet({
    templateCandidates: {
      neutral: "A routine move",
      "opening.fine": "A fine opening move",
      "opening.blunder": "A blunder in the opening",
    },
    themes: CHESS_THEMES,
  }),
});
export const response = v.parse(JevResponseSchema, narrow[0]?.response);
export const result = { response, latencyMs: 20, transport: "workers_ai" as const };
