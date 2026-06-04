import { describe, expect, it } from "bun:test";
import { getDefault, getPathsForTab, getUi, SETTINGS_SCHEMA } from "../src/config/settings-schema";

describe("settings schema", () => {
	it("exposes repo-backed plan persistence under task settings", () => {
		expect(SETTINGS_SCHEMA["plan.persistToRepo"].type).toBe("boolean");
		expect(getDefault("plan.persistToRepo")).toBe(true);
		expect(getUi("plan.persistToRepo")?.tab).toBe("tasks");
		expect(getPathsForTab("tasks").indexOf("plan.persistToRepo")).toBe(
			getPathsForTab("tasks").indexOf("plan.enabled") + 1,
		);
	});
});
