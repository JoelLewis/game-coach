// score/test-data.ts's `item()` helper has no explicit return type, so TypeScript infers wide
// field types (e.g. `source.kind: string`) that do not satisfy CalibrationItem's literal
// unions. Parsing through the real schema both fixes the type and proves the fixture is valid.
import * as v from "valibot";
import { CalibrationItemSchema, type CalibrationItem, type CalibrationLabel } from "@game-coach/contracts/calibration";
import { item as rawItem } from "../score/test-data.ts";

export const testItem = (id: string, humanLabel: CalibrationLabel | null = null): CalibrationItem =>
  v.parse(CalibrationItemSchema, rawItem(id, humanLabel));
