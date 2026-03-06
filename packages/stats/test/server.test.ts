import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { startServer } from "../src/server";

const serversToStop: Array<() => void> = [];
const listenersToClose: net.Server[] = [];

afterEach(async () => {
	while (serversToStop.length > 0) {
		serversToStop.pop()?.();
	}

	while (listenersToClose.length > 0) {
		const listener = listenersToClose.pop();
		if (!listener) continue;
		await new Promise<void>((resolve, reject) => {
			listener.close(error => (error ? reject(error) : resolve()));
		});
		listener.unref();
	}
});

async function occupyPort(): Promise<number> {
	const listener = net.createServer();
	listener.unref();
	await new Promise<void>((resolve, reject) => {
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => resolve());
	});

	const address = listener.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected TCP listener to expose an object address");
	}

	listenersToClose.push(listener);
	return address.port;
}

describe("startServer", () => {
	it("falls back to an available port when the preferred port is busy", async () => {
		const busyPort = await occupyPort();

		const server = await startServer(busyPort);
		serversToStop.push(server.stop);

		expect(server.port).not.toBe(busyPort);
		expect(server.port).toBeGreaterThan(0);

		const response = await fetch(`http://127.0.0.1:${server.port}/api/stats`);
		expect(response.ok).toBe(true);
	});
});
