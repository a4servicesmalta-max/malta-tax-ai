import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard: the UI's esc() helper must escape " and ' (attribute-context
// injection protection), not just & and <. See public/index.html esc().
describe('UI esc() escaping', () => {
  it('escapes quotes and > to prevent attribute injection', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
    expect(html).toContain('&gt;');
  });
});
