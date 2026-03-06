import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

describe('no-legacy-agent-ids', () => {
  it('no discovered agent file uses name: task', () => {
    const agentsDir = join(import.meta.dir, '../agents');
    const files = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(agentsDir, file), 'utf-8');
      if (/^name:\s*task\s*$/m.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
