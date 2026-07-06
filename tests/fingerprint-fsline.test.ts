import { describe, it, expect } from 'vitest';
import { fingerprintRules, sheetAllowed, proposeMapping } from '../src/mapping';
import { extractFiguresFromText, tieCheck } from '../src/fs-tie-check';
import { parseEtb } from '../src/etb-parser';
import { syntheticEtbXlsx } from './helpers/synthetic';

describe('ETB statement routing (PL/BS)', () => {
  it('captures the statement from a P/B flag column', () => {
    const res = parseEtb(
      syntheticEtbXlsx([
        ['Account Description', 2023, 'P/B', 'P/L', 'B/S', 2022],
        ['Audit Fees', 1450, 'P', 1450, 0, 1650],
        ['Property', 500000, 'B', 0, 500000, 500000],
      ])
    );
    expect(res.accounts.map((a) => a.statement)).toEqual(['PL', 'BS']);
  });

  it('captures the statement from P&L / Balance Sheet split columns', () => {
    const res = parseEtb(
      syntheticEtbXlsx([
        ['A/c', 'Details', 'Ref', 'Final Balance 2022', 'Profit & Loss', 'Balance Sheet', 'Final Balance 2021'],
        [20, 'Computers', 'AA1', 1284, null, 1284, 1072],
        [700, 'Audit fee', 'AA2', 1500, 1500, null, 1400],
      ])
    );
    expect(res.accounts.map((a) => a.statement)).toEqual(['BS', 'PL']);
  });

  it('sheetAllowed vetoes cross-statement mapping', () => {
    expect(sheetAllowed({ statement: 'PL' }, 'B_Sheet')).toBe(false);
    expect(sheetAllowed({ statement: 'BS' }, 'Income')).toBe(false);
    expect(sheetAllowed({ statement: null }, 'Income')).toBe(true);
    expect(sheetAllowed({}, 'B_Sheet')).toBe(true);
  });

  it('heuristic proposals respect the statement (a BS "sales ledger" account cannot land on Income)', () => {
    const { rules } = proposeMapping([
      { accountCode: '1', accountName: 'Sales control account', cyBalance: 900, pyBalance: null, statement: 'BS' },
    ]);
    expect(rules.every((r) => r.sheet === 'B_Sheet')).toBe(true);
  });

  it('fingerprints respect the statement', () => {
    const rules = fingerprintRules(
      [{ accountCode: '1', accountName: 'X', cyBalance: 0, pyBalance: 500, statement: 'BS' }],
      new Map([['Income:6000', 500]])
    );
    expect(rules).toEqual([]);
  });
});

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
