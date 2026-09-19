import { JevError } from "@game-coach/contracts/jev";
import * as v from "valibot";

export const toJevError = (error: unknown): JevError => {
  if (error instanceof JevError) return error;
  if (v.isValiError(error)) return new JevError("bad_response", error.message, error.issues);
  const message = typeof error === "string" ? error
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message : "Jev upstream failure";
  const code = message.includes("2021") || message.includes("Insufficient AI Gateway credits")
    ? "insufficient_credits" : "upstream";
  return new JevError(code, message, error);
};
