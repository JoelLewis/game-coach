import * as v from "valibot";
import {
  JEV_MODEL_ID, WORKERS_AI_COMPLETED, WorkersAiEnvelopeSchema,
  JevError, JevResponseSchema, type JevTransport,
} from "@game-coach/contracts/jev";
import { toJevError } from "./errors.ts";

export type WorkersAiBinding = { run(model: string, input: unknown): Promise<unknown> };

export const createWorkersAiTransport = (ai: WorkersAiBinding): JevTransport => ({
  async judge(request) {
    try {
      const start = Date.now();
      const raw = await ai.run(JEV_MODEL_ID, request);
      const latencyMs = Date.now() - start;
      const envelope = v.parse(WorkersAiEnvelopeSchema, raw);
      if (envelope.state !== WORKERS_AI_COMPLETED) {
        throw new JevError("bad_response", `Jev did not complete: ${envelope.state}`, raw);
      }
      return { response: v.parse(JevResponseSchema, envelope.result), latencyMs, transport: "workers_ai" };
    } catch (error) {
      throw toJevError(error);
    }
  },
});
