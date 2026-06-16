import { describe, expect, test } from "bun:test";
import {
	buildModelReferenceIndex,
	referenceHasBillableCost,
	resolveBillableModelReference,
	resolveModelReference,
} from "@oh-my-pi/pi-catalog/identity";
import type { Model } from "@oh-my-pi/pi-catalog/types";

const SYNTHETIC_API = "synthetic-reference" as const;
type SyntheticModel = Model<typeof SYNTHETIC_API>;
type SyntheticModelOverrides = Partial<Omit<SyntheticModel, "api" | "compat" | "id">>;

function modelCost(overrides: Partial<SyntheticModel["cost"]> = {}): SyntheticModel["cost"] {
	return {
		input: overrides.input ?? 0,
		output: overrides.output ?? 0,
		cacheRead: overrides.cacheRead ?? 0,
		cacheWrite: overrides.cacheWrite ?? 0,
	};
}

function syntheticModel(id: string, overrides: SyntheticModelOverrides = {}): SyntheticModel {
	return {
		id,
		name: id,
		api: SYNTHETIC_API,
		provider: "synthetic-provider",
		baseUrl: "https://models.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: modelCost(),
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat: undefined,
		...overrides,
	};
}

describe("billable model references", () => {
	test("resolveModelReference prefers a billable reference over a larger zero-cost shadow for the same key", () => {
		const zeroCostShadow = syntheticModel("claude-sonnet-4-6", {
			provider: "zero-cost-proxy",
			cost: modelCost(),
			contextWindow: 1_000_000,
			maxTokens: 200_000,
		});
		const billableReference = syntheticModel("claude-sonnet-4-6", {
			provider: "upstream-provider",
			cost: modelCost({ input: 3, output: 15 }),
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const index = buildModelReferenceIndex([zeroCostShadow, billableReference]);

		expect(resolveModelReference("claude-sonnet-4-6", index)).toBe(billableReference);
	});

	test("resolveBillableModelReference skips an exact zero-cost proxy alias for a derived billable base id", () => {
		const zeroCostAlias = syntheticModel("foo-high", {
			provider: "proxy-provider",
			cost: modelCost(),
			contextWindow: 1_000_000,
			maxTokens: 200_000,
		});
		const billableBase = syntheticModel("foo", {
			provider: "upstream-provider",
			cost: modelCost({ input: 0.5, output: 2 }),
			contextWindow: 128_000,
			maxTokens: 16_000,
		});
		const index = buildModelReferenceIndex([zeroCostAlias, billableBase]);

		expect(resolveModelReference("vendor/foo-high", index)).toBe(zeroCostAlias);
		expect(resolveBillableModelReference("vendor/foo-high", index)).toBe(billableBase);
	});

	test("resolveBillableModelReference falls back to the first match when every candidate is zero-cost", () => {
		const zeroCostAlias = syntheticModel("foo-high", {
			provider: "proxy-provider",
			cost: modelCost(),
		});
		const zeroCostBase = syntheticModel("foo", {
			provider: "upstream-provider",
			cost: modelCost(),
		});
		const index = buildModelReferenceIndex([zeroCostAlias, zeroCostBase]);

		expect(resolveBillableModelReference("vendor/foo-high", index)).toBe(zeroCostAlias);
	});

	test("referenceHasBillableCost only requires one nonzero pricing component", () => {
		expect(referenceHasBillableCost(syntheticModel("zero-cost", { cost: modelCost() }))).toBe(false);

		const billableCosts: Array<readonly [string, SyntheticModel["cost"]]> = [
			["input", modelCost({ input: 0.1 })],
			["output", modelCost({ output: 0.1 })],
			["cacheRead", modelCost({ cacheRead: 0.1 })],
			["cacheWrite", modelCost({ cacheWrite: 0.1 })],
		];

		for (const [component, cost] of billableCosts) {
			expect(referenceHasBillableCost(syntheticModel(`billable-${component}`, { cost }))).toBe(true);
		}
	});

	test("resolveBillableModelReference leaves explicit free-tier ids unpriced", () => {
		const freeAlias = syntheticModel("foo:free", { provider: "free-tier", cost: modelCost() });
		const billableBase = syntheticModel("foo", {
			provider: "upstream-provider",
			cost: modelCost({ input: 0.5, output: 2 }),
		});
		const index = buildModelReferenceIndex([freeAlias, billableBase]);

		// The paid base is reachable, but a `:free` / `-free` id must stay $0.
		expect(resolveBillableModelReference("vendor/foo:free", index)).toBeUndefined();
		expect(resolveBillableModelReference("vendor/foo-free", index)).toBeUndefined();
		// Identity resolution is unaffected and still finds a reference.
		expect(resolveModelReference("vendor/foo:free", index)).toBeDefined();
	});
});
