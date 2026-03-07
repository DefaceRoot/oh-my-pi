import { describe, expect, test } from 'bun:test';
import { resolveSessionWorkspace, slugify } from './session-workspace';

describe('slugify', () => {
	test('lowercases and replaces spaces with hyphens', () => {
		expect(slugify('Orchestrator Rebalance')).toBe('orchestrator-rebalance');
	});

	test('removes special characters', () => {
		expect(slugify('Fix: auth bug (#123)')).toBe('fix-auth-bug-123');
	});

	test('trims leading/trailing hyphens', () => {
		expect(slugify('--hello--')).toBe('hello');
	});

	test('collapses multiple hyphens', () => {
		expect(slugify('a   b   c')).toBe('a-b-c');
	});
});

describe('resolveSessionWorkspace', () => {
	test('constructs correct path', () => {
		const ws = resolveSessionWorkspace('/repo', 'refactor', 'Orchestrator Rebalance', '2026-02-26');
		expect(ws.path).toBe('/repo/.omp/sessions/refactor/2026-02-26-orchestrator-rebalance');
		expect(ws.type).toBe('refactor');
		expect(ws.slug).toBe('2026-02-26-orchestrator-rebalance');
	});

	test('uses today when no date provided', () => {
		const ws = resolveSessionWorkspace('/repo', 'feature', 'new thing');
		const today = new Date().toISOString().split('T')[0];
		expect(ws.slug.startsWith(today)).toBe(true);
	});

	test('handles all session types', () => {
		for (const type of ['feature', 'fix', 'refactor', 'chore', 'docs'] as const) {
			const ws = resolveSessionWorkspace('/repo', type, 'test', '2026-01-01');
			expect(ws.path).toContain(`/sessions/${type}/`);
		}
	});
});
