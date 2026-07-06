import { describe, it, expect } from 'vitest';
import { fingerprintRules } from '../src/mapping';
import { extractFiguresFromText, tieCheck } from '../src/fs-tie-check';

describe('prior-year value-fingerprint matching', () => {
  const acc = (code: string, name: string, cy: number, py: number | null) => ({
    accountCode: code,
    accountName: name,
    cyBalance: cy,
    pyBalance: py,
  });

  it('maps an account whose PY balance equals exactly one filed prior value', () => {
    const rules = fingerprintRules(
      [acc('4000b', 'Sales- Recharge of Costs', -95000, -93152)],
      new Map([
        ['Income:5001', -93152],
        ['Income:5000', -206755],
      ])
    );
    expect(rules).toEqual([{ ledgerCode: '4000b', cfrCode: 5001, sheet: 'Income', confidence: 0.99 }]);
  });

  it('skips ambiguous fingerprints (two lines or two accounts with the same value)', () => {
    // two prior lines carry the same value
    expect(
      fingerprintRules([acc('1', 'A', 0, 500)], new Map([['Income:6000', 500], ['Income:6100', 500]]))
    ).toEqual([]);
    // two accounts share the balance
    expect(
      fingerprintRules([acc('1', 'A', 0, 500), acc('2', 'B', 0, 500)], new Map([['Income:6000', 500]]))
    ).toEqual([]);
  });

  it('ignores near-zero balances and null PY', () => {
    expect(fingerprintRules([acc('1', 'A', 100, 0), acc('2', 'B', 100, null)], new Map([['Income:6000', 0]]))).toEqual(
      []
    );
  });
});

describe('FS line-by-line tie', () => {
  it('extracts revenue, total equity and total liabilities from FS text', () => {
    const f = extractFiguresFromText(
      ['Revenue 1,240,000', 'Profit for the year 182,400', 'Total assets 3,500,000', 'Total equity 900,000', 'Total liabilities 2,600,000', 'Total equity and liabilities 3,500,000'].join(
        '\n'
      )
    );
    expect(f.revenue).toBe(1240000);
    expect(f.totalEquity).toBe(900000); // NOT the "equity and liabilities" total
    expect(f.totalLiabilities).toBe(2600000);
  });

  it('ties extended lines on magnitude and flags real disagreements', () => {
    const res = tieCheck(
      { netProfit: 100, totalAssets: 500, revenue: 1000, totalEquity: 300, totalLiabilities: 200 },
      { netProfit: 100, totalAssets: 500, revenue: -1000, totalEquity: -300, totalLiabilities: -150 }
    );
    expect(res.checks.revenue).toBe('tied');
    expect(res.checks.totalEquity).toBe('tied');
    expect(res.checks.totalLiabilities).toBe('mismatch');
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.includes('Total liabilities does not tie'))).toBe(true);
  });

  it('stays quiet when the FS does not carry an extended line', () => {
    const res = tieCheck({ netProfit: 100, totalAssets: 500 }, { netProfit: 100, totalAssets: 500, revenue: -1000 });
    expect(res.checks.revenue).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});
