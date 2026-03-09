import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("lsp serverName propagation", () => {
	it("adds serverName to loaded server configs", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-server-name-");

		try {
			const serverName = "unit-server-name";
			await Bun.write(path.join(tempDir.path(), "package.json"), '{"name":"tmp"}\n');
			await Bun.write(
				path.join(tempDir.path(), "lsp.json"),
				JSON.stringify(
					{
						servers: {
							[serverName]: {
								command: "sh",
								fileTypes: [".ts"],
								rootMarkers: ["package.json"],
							},
						},
					},
					null,
					2,
				),
			);

			const config = loadConfig(tempDir.path());
			const loaded = config.servers[serverName];
			expect(loaded).toBeDefined();
			expect((loaded as Record<string, unknown> | undefined)?.serverName).toBe(serverName);
		} finally {
			tempDir.removeSync();
		}
	});
});
