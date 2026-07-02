import { describe, it, expect } from 'vitest';
import { extractFsFigures, tieCheck } from '../src/fs-tie-check';
import { syntheticEtbXlsx } from './helpers/synthetic';

describe('fs-tie-check', () => {
  it('extracts net profit and total assets from an FS workbook by label', () => {
    const buf = syntheticEtbXlsx([
      ['Statement of comprehensive income', null],
      ['Profit for the year', 78500],
      ['Statement of financial position', null],
      ['Total assets', 120000],
    ]);
    const figs = extractFsFigures(buf);
    expect(figs.netProfit).toBe(78500);
    expect(figs.totalAssets).toBe(120000);
  });

  it('passes when ETB-derived figures tie within €1', () => {
    const res = tieCheck({ netProfit: 78500, totalAssets: 120000 }, { netProfit: 78500.4, totalAssets: 120000 });
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('reports differences when figures do not tie', () => {
    const res = tieCheck({ netProfit: 78500, totalAssets: 120000 }, { netProfit: 70000, totalAssets: 120000 });
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toMatch(/net profit/i);
    expect(res.issues[0]).toContain('8500');
  });
});
