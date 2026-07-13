import { describe, it, expect } from 'vitest';
import { deriveSectionTotals, applyClosingEntry, TOTAL_CODE_KEYS } from '../src/mapping';

describe('applyClosingEntry — 7050 net income BEFORE tax', () => {
  it('excludes the below-the-line tax charge (7060+) from the 7050 row', () => {
    const templateKeys = new Set(['Income:7050', 'Income:7501', 'Income:7600', 'B_Sheet:3905']);
    // Post-closing signature: B_Sheet balances; Income still stated, incl a tax
    // charge booked to 7060. 7050 ("NET INCOME BEFORE TAX") must be revenue +
    // expenses ONLY (−700), never net of the €100 tax (−600).
    const out = applyClosingEntry(
      [
        { sheet: 'B_Sheet', cfrCode: 2150, amount: 800 },
        { sheet: 'B_Sheet', cfrCode: 3801, amount: -200 },
        { sheet: 'B_Sheet', cfrCode: 3905, amount: -600 },
        { sheet: 'Income', cfrCode: 5000, amount: -1000 },
        { sheet: 'Income', cfrCode: 6000, amount: 300 },
        { sheet: 'Income', cfrCode: 7060, amount: 100 },
      ],
      templateKeys
    );
    expect(out.find((c) => c.sheet === 'Income' && c.cfrCode === 7050)?.amount).toBe(-700);
  });
});

const cells = [
  { sheet: 'B_Sheet' as const, cfrCode: 2150, amount: 1000 },
  { sheet: 'B_Sheet' as const, cfrCode: 2052, amount: 500 },
  { sheet: 'B_Sheet' as const, cfrCode: 3101, amount: -300 },
  { sheet: 'B_Sheet' as const, cfrCode: 3801, amount: -1200 },
  { sheet: 'Income' as const, cfrCode: 5000, amount: -9000 },
  { sheet: 'Income' as const, cfrCode: 6173, amount: 1500 },
];
const allWritable = TOTAL_CODE_KEYS;

describe('deriveSectionTotals', () => {
  it('derives typed section totals from mapped lines', () => {
    const t = deriveSectionTotals(cells, allWritable);
    const at = (s: string, c: number) => t.find((x) => x.sheet === s && x.cfrCode === c)?.amount;
    expect(at('B_Sheet', 2299)).toBe(1500); // assets
    expect(at('B_Sheet', 3799)).toBe(-300); // liabilities
    expect(at('B_Sheet', 3998)).toBe(-1200); // equity
    expect(at('Income', 5499)).toBe(-9000); // revenue
    // 7050 deliberately NOT derived (formula/duplicate twins on real templates).
    expect(at('Income', 7050)).toBeUndefined();
  });

  it('never writes a total the template computes itself (not in writable set)', () => {
    const t = deriveSectionTotals(cells, new Set(['B_Sheet:2299']));
    expect(t).toHaveLength(1);
    expect(t[0].cfrCode).toBe(2299);
  });

  it('never overwrites a total the mapping already produced', () => {
    const withOwn = [...cells, { sheet: 'B_Sheet' as const, cfrCode: 2299, amount: 999 }];
    const t = deriveSectionTotals(withOwn, allWritable);
    expect(t.some((x) => x.cfrCode === 2299)).toBe(false);
  });

  it('skips zero-sum sections', () => {
    const t = deriveSectionTotals([{ sheet: 'Income' as const, cfrCode: 6000, amount: 0 }], allWritable);
    expect(t.filter((x) => x.sheet === 'Income')).toHaveLength(0);
  });
});
