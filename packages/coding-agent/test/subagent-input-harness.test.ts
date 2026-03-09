import { describe, expect, test, vi } from "bun:test";
import {
	CTRL_N,
	CTRL_O,
	CTRL_P,
	CTRL_R,
	CTRL_V,
	CTRL_X,
	TestTui,
} from "./subagent-input-harness";

describe("subagent input harness", () => {
	test("ctrl-byte constants are correct and round-trip through the input listener", () => {
		expect(CTRL_X).toBe("\x18");
		expect(CTRL_N).toBe("\x0e");
		expect(CTRL_P).toBe("\x10");
		expect(CTRL_O).toBe("\x0f");
		expect(CTRL_R).toBe("\x12");
		expect(CTRL_V).toBe("\x16");

		const tui = new TestTui();
		const listener = vi.fn((data: string) => ({ data }));
		tui.addInputListener(listener);

		for (const ctrlByte of [CTRL_X, CTRL_N, CTRL_P, CTRL_O, CTRL_R, CTRL_V]) {
			const result = tui.send(ctrlByte);
			expect(result).toEqual({ consumed: false, forwardedData: ctrlByte });
		}

		expect(listener).toHaveBeenCalledTimes(6);
	});

	test("send stays synchronous under fake timers", () => {
		vi.useFakeTimers();
		try {
			const tui = new TestTui();
			const listener = vi.fn((data: string) => ({ data: `wrapped:${data}` }));
			tui.addInputListener(listener);

			const result = tui.send(CTRL_X);
			expect(result).toEqual({ consumed: false, forwardedData: `wrapped:${CTRL_X}` });
			expect(listener).toHaveBeenCalledWith(CTRL_X);
		} finally {
			vi.useRealTimers();
		}
	});

	test("unsubscribed listeners are not called and active listeners still run", () => {
		const tui = new TestTui();
		const alwaysOnListener = vi.fn((data: string) => ({ data: `base:${data}` }));
		const temporaryListener = vi.fn(() => ({ consume: true }));

		tui.addInputListener(alwaysOnListener);
		const unsubscribeTemporary = tui.addInputListener(temporaryListener);

		expect(tui.send("before")).toEqual({ consumed: true, forwardedData: "" });
		expect(alwaysOnListener).toHaveBeenCalledTimes(1);
		expect(temporaryListener).toHaveBeenCalledTimes(1);

		unsubscribeTemporary();

		expect(tui.send("after")).toEqual({ consumed: false, forwardedData: "base:after" });
		expect(alwaysOnListener).toHaveBeenCalledTimes(2);
		expect(temporaryListener).toHaveBeenCalledTimes(1);
	});
});