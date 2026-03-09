export type TestInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TestInputListener = (data: string) => TestInputListenerResult;

export type TestInputSendResult = {
	consumed: boolean;
	forwardedData: string;
};

export const CTRL_X = "\x18";
export const CTRL_N = "\x0e";
export const CTRL_P = "\x10";
export const CTRL_O = "\x0f";
export const CTRL_R = "\x12";
export const CTRL_V = "\x16";

export class TestTui {
	#listeners = new Set<TestInputListener>();

	addInputListener(listener: TestInputListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	send(data: string): TestInputSendResult {
		let forwardedData = data;
		for (const listener of this.#listeners) {
			const result = listener(forwardedData);
			if (result?.consume) {
				return { consumed: true, forwardedData: "" };
			}
			if (result?.data !== undefined) {
				forwardedData = result.data;
			}
		}
		return { consumed: false, forwardedData };
	}
}