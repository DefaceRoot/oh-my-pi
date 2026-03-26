import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";

describe("personality setting schema", () => {
	it("should use enum type", () => {
		expect(SETTINGS_SCHEMA.personality.type).toBe("enum");
	});

	it("should include plain-english and technical values", () => {
		expect(SETTINGS_SCHEMA.personality.values).toContain("plain-english");
		expect(SETTINGS_SCHEMA.personality.values).toContain("technical");
	});

	it("should default to plain-english", () => {
		expect(SETTINGS_SCHEMA.personality.default).toBe("plain-english");
	});

	it("should appear in the interaction tab", () => {
		expect(SETTINGS_SCHEMA.personality.ui?.tab).toBe("interaction");
	});
});
