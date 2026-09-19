import * as v from "valibot";
import { JevError, JevResponseSchema, type JevTransport } from "@game-coach/contracts/jev";
import { toJevError } from "./errors.ts";

export type TypesafeHttpOptions = {
  apiKey: string;
  // The real TypeSafe endpoint is unverified; callers must supply it explicitly.
  endpoint: string;
  fetch?: typeof globalThis.fetch;
};

export const createTypesafeHttpTransport = (options: TypesafeHttpOptions): JevTransport => ({
  async judge(request) {
    try {
      const start = Date.now();
      const reply = await (options.fetch ?? globalThis.fetch)(options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ state: request.state, questions: request.questions }),
      });
      const text = await reply.text();
      const latencyMs = Date.now() - start;
      if (!reply.ok) throw new Error(`TypeSafe HTTP ${reply.status}: ${text}`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (error) {
        throw new JevError("bad_response", "TypeSafe returned invalid JSON", error);
      }
      return { response: v.parse(JevResponseSchema, body), latencyMs, transport: "typesafe_http" };
    } catch (error) {
      throw toJevError(error);
    }
  },
});
