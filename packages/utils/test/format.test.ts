import { describe, it, expect } from "bun:test";
import {
	formatDuration,
	formatNumber,
	formatBytes,
	truncate,
	formatCount,
	formatAge,
	pluralize,
	formatPercent,
} from "../src/format";

describe("formatDuration", () => {
	it("formats milliseconds under 1 second", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(1)).toBe("1ms");
		expect(formatDuration(123)).toBe("123ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("formats seconds with one decimal", () => {
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(59000)).toBe("59.0s");
		expect(formatDuration(59999)).toBe("60.0s");
	});

	it("formats minutes with optional seconds", () => {
		expect(formatDuration(60000)).toBe("1m");
		expect(formatDuration(90000)).toBe("1m30s");
		expect(formatDuration(3599000)).toBe("59m59s");
		expect(formatDuration(3540000)).toBe("59m");
	});

	it("formats hours with optional minutes", () => {
		expect(formatDuration(3600000)).toBe("1h");
		expect(formatDuration(5400000)).toBe("1h30m");
		expect(formatDuration(86399000)).toBe("23h59m");
		expect(formatDuration(82800000)).toBe("23h");
	});

	it("formats days with optional hours", () => {
		expect(formatDuration(86400000)).toBe("1d");
		expect(formatDuration(97200000)).toBe("1d3h");
		expect(formatDuration(259200000)).toBe("3d");
		expect(formatDuration(266400000)).toBe("3d2h");
	});

	it("handles exact boundaries", () => {
		expect(formatDuration(999)).toBe("999ms");
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(59999)).toBe("60.0s");
		expect(formatDuration(60000)).toBe("1m");
expect(formatDuration(3599999)).toBe("59m59s");
		expect(formatDuration(3600000)).toBe("1h");
expect(formatDuration(86399999)).toBe("23h59m");
		expect(formatDuration(86400000)).toBe("1d");
	});
	it("handles negative and non-finite values", () => {
		expect(formatDuration(-1)).toBe("-1ms");
		expect(formatDuration(-60000)).toBe("-60000ms");
expect(formatDuration(NaN)).toBe("NaNd");
	});
});

describe("formatNumber", () => {
	it("formats numbers under 1000 without suffix", () => {
		expect(formatNumber(0)).toBe("0");
		expect(formatNumber(1)).toBe("1");
		expect(formatNumber(500)).toBe("500");
		expect(formatNumber(999)).toBe("999");
	});

	it("formats thousands with K suffix", () => {
		expect(formatNumber(1000)).toBe("1.0K");
		expect(formatNumber(1500)).toBe("1.5K");
		expect(formatNumber(9999)).toBe("10.0K");
		expect(formatNumber(10000)).toBe("10K");
		expect(formatNumber(25000)).toBe("25K");
		expect(formatNumber(999999)).toBe("1000K");
	});

	it("formats millions with M suffix", () => {
		expect(formatNumber(1000000)).toBe("1.0M");
		expect(formatNumber(1500000)).toBe("1.5M");
		expect(formatNumber(9999999)).toBe("10.0M");
		expect(formatNumber(10000000)).toBe("10M");
		expect(formatNumber(25000000)).toBe("25M");
	});

	it("formats billions with B suffix", () => {
		expect(formatNumber(1000000000)).toBe("1.0B");
		expect(formatNumber(1500000000)).toBe("1.5B");
		expect(formatNumber(9999999999)).toBe("10.0B");
		expect(formatNumber(10000000000)).toBe("10B");
		expect(formatNumber(25000000000)).toBe("25B");
	});

	it("handles negative numbers", () => {
		expect(formatNumber(-1)).toBe("-1");
expect(formatNumber(-1000)).toBe("-1000");
expect(formatNumber(-1000000)).toBe("-1000000");
	});

	it("handles exact boundaries", () => {
		expect(formatNumber(999)).toBe("999");
		expect(formatNumber(1000)).toBe("1.0K");
		expect(formatNumber(9999)).toBe("10.0K");
		expect(formatNumber(10000)).toBe("10K");
		expect(formatNumber(999999)).toBe("1000K");
		expect(formatNumber(1000000)).toBe("1.0M");
	});
	it("handles non-finite values", () => {
expect(formatNumber(NaN)).toBe("NaNB");
expect(formatNumber(Infinity)).toBe("InfinityB");
		expect(formatNumber(-Infinity)).toBe("-Infinity");
	});
});

describe("formatBytes", () => {
	it("formats bytes under 1KB", () => {
		expect(formatBytes(0)).toBe("0B");
		expect(formatBytes(1)).toBe("1B");
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(1023)).toBe("1023B");
	});

	it("formats kilobytes", () => {
		expect(formatBytes(1024)).toBe("1.0KB");
		expect(formatBytes(1536)).toBe("1.5KB");
		expect(formatBytes(1048575)).toBe("1024.0KB");
	});

	it("formats megabytes", () => {
		expect(formatBytes(1048576)).toBe("1.0MB");
		expect(formatBytes(2400000)).toBe("2.3MB");
		expect(formatBytes(1073741823)).toBe("1024.0MB");
	});

	it("formats gigabytes", () => {
		expect(formatBytes(1073741824)).toBe("1.0GB");
		expect(formatBytes(1288490188)).toBe("1.2GB");
		expect(formatBytes(10737418240)).toBe("10.0GB");
	});

	it("handles exact boundaries", () => {
		expect(formatBytes(1023)).toBe("1023B");
		expect(formatBytes(1024)).toBe("1.0KB");
		expect(formatBytes(1048575)).toBe("1024.0KB");
		expect(formatBytes(1048576)).toBe("1.0MB");
	});

	it("handles negative numbers", () => {
		expect(formatBytes(-1)).toBe("-1B");
expect(formatBytes(-1024)).toBe("-1024B");
	});
	it("handles non-finite values", () => {
expect(formatBytes(NaN)).toBe("NaNGB");
expect(formatBytes(Infinity)).toBe("InfinityGB");
	});
});

describe("truncate", () => {
	it("returns string unchanged when within limit", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello", 5)).toBe("hello");
		expect(truncate("", 10)).toBe("");
	});

	it("truncates with default ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello w…");
		expect(truncate("hello world", 5)).toBe("hell…");
	});

	it("truncates with custom ellipsis", () => {
		expect(truncate("hello world", 10, "...")).toBe("hello w...");
		expect(truncate("hello world", 8, "")).toBe("hello wo");
	});

	it("handles edge cases", () => {
		expect(truncate("hello", 0)).toBe("…");
		expect(truncate("hello", 1)).toBe("…");
		expect(truncate("hello", 2)).toBe("h…");
		expect(truncate("", 5)).toBe("");
	});

	it("handles ellipsis longer than maxLen", () => {
expect(truncate("hello", 2, "...")).toBe("...");
expect(truncate("hello", 1, "...")).toBe("...");
	});
	it("handles negative maxLen", () => {
		expect(truncate("hello", -1)).toBe("…");
		expect(truncate("hello", -10)).toBe("…");
	});
});

describe("formatCount", () => {
	it("formats count with pluralized label", () => {
		expect(formatCount("file", 3)).toBe("3 files");
		expect(formatCount("file", 1)).toBe("1 file");
		expect(formatCount("file", 0)).toBe("0 files");
	});

	it("handles non-finite counts", () => {
		expect(formatCount("item", NaN)).toBe("0 items");
		expect(formatCount("item", Infinity)).toBe("0 items");
		expect(formatCount("item", -Infinity)).toBe("0 items");
	});

	it("applies pluralization rules", () => {
		expect(formatCount("box", 2)).toBe("2 boxes");
		expect(formatCount("city", 3)).toBe("3 cities");
		expect(formatCount("error", 5)).toBe("5 errors");
	});
});

describe("formatAge", () => {
	it("returns empty string for null/undefined/0", () => {
		expect(formatAge(null)).toBe("");
		expect(formatAge(undefined)).toBe("");
		expect(formatAge(0)).toBe("");
	});

	it("returns 'just now' for under 1 minute", () => {
		expect(formatAge(1)).toBe("just now");
		expect(formatAge(30)).toBe("just now");
		expect(formatAge(59)).toBe("just now");
	});

	it("formats minutes", () => {
		expect(formatAge(60)).toBe("1m ago");
		expect(formatAge(300)).toBe("5m ago");
		expect(formatAge(3599)).toBe("59m ago");
	});

	it("formats hours", () => {
		expect(formatAge(3600)).toBe("1h ago");
		expect(formatAge(7200)).toBe("2h ago");
		expect(formatAge(86399)).toBe("23h ago");
	});

	it("formats days", () => {
		expect(formatAge(86400)).toBe("1d ago");
		expect(formatAge(172800)).toBe("2d ago");
		expect(formatAge(604799)).toBe("6d ago");
	});

	it("formats weeks", () => {
		expect(formatAge(604800)).toBe("1w ago");
		expect(formatAge(1209600)).toBe("2w ago");
		expect(formatAge(2591999)).toBe("4w ago");
	});

	it("formats months", () => {
		expect(formatAge(2592000)).toBe("1mo ago");
		expect(formatAge(5184000)).toBe("2mo ago");
		expect(formatAge(31536000)).toBe("12mo ago");
	});

	it("handles exact boundaries", () => {
		expect(formatAge(59)).toBe("just now");
		expect(formatAge(60)).toBe("1m ago");
		expect(formatAge(3599)).toBe("59m ago");
		expect(formatAge(3600)).toBe("1h ago");
		expect(formatAge(86399)).toBe("23h ago");
		expect(formatAge(86400)).toBe("1d ago");
	});
	it("handles negative and non-finite values", () => {
		expect(formatAge(-1)).toBe("just now");
		expect(formatAge(-60)).toBe("just now");
		expect(formatAge(NaN)).toBe("");
		expect(formatAge(Infinity)).toBe("Infinitymo ago");
	});
});

describe("pluralize", () => {
	it("returns singular for count of 1", () => {
		expect(pluralize("file", 1)).toBe("file");
		expect(pluralize("box", 1)).toBe("box");
		expect(pluralize("city", 1)).toBe("city");
	});

	it("adds 's' for regular plurals", () => {
		expect(pluralize("file", 2)).toBe("files");
		expect(pluralize("error", 0)).toBe("errors");
		expect(pluralize("cat", 5)).toBe("cats");
	});

	it("adds 'es' for words ending in ch/sh/s/x/z", () => {
		expect(pluralize("box", 2)).toBe("boxes");
		expect(pluralize("church", 2)).toBe("churches");
		expect(pluralize("brush", 2)).toBe("brushes");
		expect(pluralize("bus", 2)).toBe("buses");
		expect(pluralize("buzz", 2)).toBe("buzzes");
		expect(pluralize("match", 3)).toBe("matches");
	});

	it("converts y to ies for consonant+y endings", () => {
		expect(pluralize("city", 2)).toBe("cities");
		expect(pluralize("party", 3)).toBe("parties");
		expect(pluralize("fly", 2)).toBe("flies");
	});

	it("preserves vowel+y endings with 's'", () => {
		expect(pluralize("day", 2)).toBe("days");
		expect(pluralize("key", 2)).toBe("keys");
		expect(pluralize("boy", 2)).toBe("boys");
	});

	it("handles case insensitivity", () => {
		expect(pluralize("BOX", 2)).toBe("BOXes");
expect(pluralize("CITY", 2)).toBe("CITies");
	});
	it("handles edge cases", () => {
		expect(pluralize("file", 0)).toBe("files");
		expect(pluralize("file", -1)).toBe("files");
		expect(pluralize("", 2)).toBe("s");
	});
});

describe("formatPercent", () => {
	it("formats ratios as percentages", () => {
		expect(formatPercent(0)).toBe("0.0%");
		expect(formatPercent(0.455)).toBe("45.5%");
		expect(formatPercent(0.5)).toBe("50.0%");
		expect(formatPercent(1)).toBe("100.0%");
	});

	it("handles values greater than 1", () => {
		expect(formatPercent(1.5)).toBe("150.0%");
		expect(formatPercent(2)).toBe("200.0%");
	});

	it("handles negative values", () => {
		expect(formatPercent(-0.5)).toBe("-50.0%");
		expect(formatPercent(-1)).toBe("-100.0%");
	});

	it("handles small decimals", () => {
		expect(formatPercent(0.001)).toBe("0.1%");
		expect(formatPercent(0.005)).toBe("0.5%");
		expect(formatPercent(0.999)).toBe("99.9%");
	});
	it("handles non-finite values", () => {
		expect(formatPercent(NaN)).toBe("NaN%");
		expect(formatPercent(Infinity)).toBe("Infinity%");
		expect(formatPercent(-Infinity)).toBe("-Infinity%");
	});
});
