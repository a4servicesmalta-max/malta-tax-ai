import { describe, it, expect } from 'vitest';
import { itaLoaded, articleByNumber, findArticles, statutoryContext } from '../src/tax-law';

describe('cached Income Tax Act (Cap. 123)', () => {
  it('ships with the Act loaded', () => {
    expect(itaLoaded()).toBe(true);
  });

  it('retrieves the core computation articles by number', () => {
    expect(articleByNumber('14')?.text).toMatch(/there shall be deducted all outgoings/i);
    expect(articleByNumber('12')?.text).toMatch(/exempt from the tax/i);
    expect(articleByNumber('56')?.text).toMatch(/chargeable income/i);
  });

  it('keyword retrieval finds relevant articles', () => {
    const hits = findArticles(['dividend', 'participating holding']);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('statutoryContext embeds core articles as prompt excerpts', () => {
    const ctx = statutoryContext(['depreciation']);
    expect(ctx).toContain('Cap. 123');
    expect(ctx).toContain('--- Article 14 ---');
    expect(ctx).toContain('--- Article 56 ---');
    expect(ctx.length).toBeLessThan(20000); // prompt-sized, not the whole Act
  });
});
