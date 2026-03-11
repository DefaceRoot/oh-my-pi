import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { sanitizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";

describe("RED: sanitizeSchemaForMCP boolean schema preservation", () => {
	it("keeps additionalProperties: false valid for AJV", () => {
		const inputSchema = {
			type: "object",
			properties: {
				url: { type: "string" },
			},
			required: ["url"],
			additionalProperties: false,
		} as const;

		const sanitized = sanitizeSchemaForMCP(inputSchema) as Record<string, unknown>;
		expect(sanitized.additionalProperties).toBe(false);

		const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
		expect(() => ajv.compile(sanitized)).not.toThrow();

		const validate = ajv.compile(sanitized);
		expect(validate({ url: "https://example.com" })).toBe(true);
		expect(validate({ url: "https://example.com", extra: true })).toBe(false);
	});
});
