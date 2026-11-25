// Checks an API answer against a schema. A wrong shape is an error to show,
// never an empty screen that looks like "nothing wrong".

import type { z } from "zod";
import { UnexpectedAnswer } from "@/lib/admin/api";

export function checked<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new UnexpectedAnswer();
  return result.data;
}
