import { z } from "zod";

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: string[] };

export function validateWithSchema<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
): ValidationResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return {
      ok: true,
      data: result.data,
    };
  }

  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    }),
  };
}

export function parseWithSchema<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
  label: string,
): T {
  const result = validateWithSchema(schema, input);

  if (result.ok) {
    return result.data;
  }

  throw new Error(`${label} validation failed:\n${result.errors.join("\n")}`);
}
