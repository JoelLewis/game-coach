// Thin client over the server's two-endpoint API. No retries, no caching: this
// is a single-user local tool, and a failed request should surface immediately.
import * as v from "valibot";
import { type CalibrationItem, type CalibrationLabel, CalibrationItemSchema } from "@game-coach/contracts/calibration";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const parseErrorBody = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) return String((body as { error: unknown }).error);
  } catch {
    // Fall through to the status text below.
  }
  return response.statusText || `HTTP ${response.status}`;
};

export const fetchItems = async (): Promise<CalibrationItem[]> => {
  const response = await fetch("/api/items");
  if (!response.ok) throw new ApiError(await parseErrorBody(response), response.status);
  const body: unknown = await response.json();
  return v.parse(v.array(CalibrationItemSchema), body);
};

export const putLabel = async (id: string, label: CalibrationLabel): Promise<CalibrationItem> => {
  const response = await fetch(`/api/items/${encodeURIComponent(id)}/label`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(label),
  });
  if (!response.ok) throw new ApiError(await parseErrorBody(response), response.status);
  const body: unknown = await response.json();
  return v.parse(CalibrationItemSchema, body);
};
