import { describe, expect, test } from 'bun:test';
import { parseGitStatusSnapshot, computeFilesDelta } from './task-file-tracker';

describe('parseGitStatusSnapshot', () => {
	test('parses porcelain output into file set', () => {
		const output = ' M src/foo.ts\n M src/bar.ts\n?? new-file.ts\n';
		const result = parseGitStatusSnapshot(output);
		expect(result).toEqual(new Set(['src/foo.ts', 'src/bar.ts', 'new-file.ts']));
	});

	test('handles renamed files (both old and new paths)', () => {
		const output = 'R  old-name.ts -> new-name.ts\n';
		const result = parseGitStatusSnapshot(output);
		expect(result.has('old-name.ts')).toBe(true);
		expect(result.has('new-name.ts')).toBe(true);
	});

	test('handles empty output', () => {
		expect(parseGitStatusSnapshot('')).toEqual(new Set());
	});

	test('handles added, modified, deleted statuses', () => {
		const output = 'A  added.ts\nM  modified.ts\nD  deleted.ts\n';
		const result = parseGitStatusSnapshot(output);
		expect(result).toEqual(new Set(['added.ts', 'modified.ts', 'deleted.ts']));
	});

	test('trims whitespace from paths', () => {
		const output = ' M  src/foo.ts \n';
		const result = parseGitStatusSnapshot(output);
		expect(result.has('src/foo.ts')).toBe(true);
	});
});

describe('computeFilesDelta', () => {
	test('returns files in after but not in before', () => {
		const before = new Set(['existing.ts']);
		const after = new Set(['existing.ts', 'new.ts', 'another.ts']);
		expect(computeFilesDelta(before, after)).toEqual(new Set(['new.ts', 'another.ts']));
	});

	test('returns empty set when no new files', () => {
		const before = new Set(['a.ts', 'b.ts']);
		const after = new Set(['a.ts', 'b.ts']);
		expect(computeFilesDelta(before, after)).toEqual(new Set());
	});

	test('handles empty before set', () => {
		const after = new Set(['a.ts']);
		expect(computeFilesDelta(new Set(), after)).toEqual(new Set(['a.ts']));
	});

	test('handles empty after set', () => {
		const before = new Set(['a.ts']);
		expect(computeFilesDelta(before, new Set())).toEqual(new Set());
	});
});
