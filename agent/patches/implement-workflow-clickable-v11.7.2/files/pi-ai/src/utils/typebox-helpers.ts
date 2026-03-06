import { type TUnsafe, Type } from "@sinclair/typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<const T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

export const NO_STRICT = Bun.env.PI_NO_STRICT === "1";

/**
 * Build a permissive JSON value schema that still satisfies strict providers.
 * OpenAI/Codex rejects empty schema nodes (for example `items: {}`) because
 * each schema object must include a concrete type/combinator.
 */
function createLooseJsonSchema(depth = 2): Record<string, unknown> {
  const primitives: Record<string, unknown>[] = [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ];
  if (depth <= 0) {
    return { anyOf: primitives };
  }
  const nested = createLooseJsonSchema(depth - 1);
  return {
    anyOf: [
      ...primitives,
      { type: "array", items: nested },
      {
        type: "object",
        additionalProperties: false,
        patternProperties: {
          "^(.*)$": nested,
        },
      },
    ],
  };
}

/**
 * Recursively enforces JSON Schema constraints required by OpenAI/Codex strict mode:
 *   - `additionalProperties: false` on every object node
 *   - every key in `properties` present in `required`
 *
 * Properties absent from the original `required` array were TypeBox-optional.
 * They are made nullable (`anyOf: [T, { type: "null" }]`) so the model can
 * signal omission by outputting null rather than omitting the key entirely.
 */
export function enforceStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };

  if (Object.keys(result).length === 0) {
    return createLooseJsonSchema();
  }

  if (result.type === "object") {
    result.additionalProperties = false;
    if (result.properties != null && typeof result.properties === "object") {
      const props = result.properties as Record<string, Record<string, unknown>>;
      const required = new Set(Array.isArray(result.required) ? (result.required as string[]) : []);
      result.properties = Object.fromEntries(
        Object.entries(props).map(([k, v]) => {
          const processed = enforceStrictSchema(v);
          // Optional property — wrap as nullable so strict mode accepts it
          if (!required.has(k)) {
            return [k, { anyOf: [processed, { type: "null" }] }];
          }
          return [k, processed];
        }),
      );
      result.required = Object.keys(props);
    }
    if (result.patternProperties != null && typeof result.patternProperties === "object") {
      const patterns = result.patternProperties as Record<string, unknown>;
      result.patternProperties = Object.fromEntries(
        Object.entries(patterns).map(([k, v]) => {
          if (v != null && typeof v === "object" && !Array.isArray(v)) {
            return [k, enforceStrictSchema(v as Record<string, unknown>)];
          }
          return [k, createLooseJsonSchema()];
        }),
      );
    }
  }
  if (result.type === "array" && !Object.hasOwn(result, "items")) {
    // OpenAI/Codex strict mode rejects arrays without an explicit `items` schema.
    // Use a typed permissive schema instead of `{}` so function registration succeeds.
    result.items = createLooseJsonSchema();
  }
  if (result.items != null && typeof result.items === "object" && !Array.isArray(result.items)) {
    result.items = enforceStrictSchema(result.items as Record<string, unknown>);
  }
  for (const key of ["anyOf", "allOf", "oneOf"] as const) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Record<string, unknown>[]).map(enforceStrictSchema);
    }
  }
  return result;
}
