import { describe, expect, test } from "bun:test";
import { renderTemplate } from "@oh-my-pi/pi-coding-agent/task/template";

describe("renderTemplate", () => {
	test("returns assignment as task when no context", () => {
		const result = renderTemplate(undefined, {
			id: "Test",
			description: "Short label",
			assignment: "Do the thing in detail.\nStep 1: read file.\nStep 2: edit it.",
		});
		expect(result.task).toBe("Do the thing in detail.\nStep 1: read file.\nStep 2: edit it.");
		expect(result.id).toBe("Test");
		expect(result.description).toBe("Short label");
	});

	test("renders TOON-only prompt without legacy XML wrappers", () => {
		const result = renderTemplate(
			"Shared constraints here",
			{
				id: "TaskA",
				description: "First task",
				assignment: "Full instructions for the agent.\nWith multiple lines.",
			},
			{ delegationContext: "Task-specific background" },
		);

		expect(result.task).toContain("Shared constraints here");
		expect(result.task).toContain("Task-specific background");
		expect(result.task).toContain("Full instructions for the agent.\nWith multiple lines.");
		expect(result.task).not.toContain("<context>");
		expect(result.task).not.toContain("</context>");
		expect(result.task).not.toContain("<goal>");
		expect(result.task).not.toContain("</goal>");
	});
});
