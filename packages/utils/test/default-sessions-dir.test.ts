import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetProfileSnapshotForTests,
	getDefaultSessionsDir,
	getSessionsDir,
	refreshDirsFromEnv,
} from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

describe("default sessions dir", () => {
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (originalAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		__resetProfileSnapshotForTests();
		refreshDirsFromEnv();
	});

	// One self-contained test keeps the global PI_CODING_AGENT_DIR mutation from
	// racing sibling dir tests in the same process: it captures the override-free
	// baseline at runtime (robust to PI_CONFIG_DIR/XDG) and asserts the override
	// is honored by getSessionsDir but ignored by getDefaultSessionsDir.
	it("resolves the override-independent default sessions dir", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		__resetProfileSnapshotForTests();
		refreshDirsFromEnv();

		const baseline = getSessionsDir();
		expect(getDefaultSessionsDir()).toBe(baseline);

		const customAgentDir = path.join(os.tmpdir(), "pi-utils-default-sessions", Snowflake.next(), "agent");
		process.env.PI_CODING_AGENT_DIR = customAgentDir;
		__resetProfileSnapshotForTests();
		refreshDirsFromEnv();

		expect(getSessionsDir()).toBe(path.join(customAgentDir, "sessions"));
		expect(getDefaultSessionsDir()).toBe(baseline);
	});
});
