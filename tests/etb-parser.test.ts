import { describe, it, expect } from 'vitest';
import { parseEtb } from '../src/etb-parser';
import { syntheticEtbXlsx } from './helpers/synthetic';

describe('parseEtb', () => {
  it('parses a code/name/debit/credit layout with a preamble row', () => {
    const buf = syntheticEtbXlsx([
      ['Client X — Extended Trial Balance FY2025', null, null, null],
      ['Code', 'Account Name', 'Debit', 'Credit'],
      ['1200', 'Bank current account', 5000, null],
      ['4000', 'Sales', null, 80000],
      ['5000', 'Cost of sales', 75000, null],
      [null, 'Totals', 80000, 80000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: null },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: null },
      { accountCode: '5000', accountName: 'Cost of sales', cyBalance: 75000, pyBalance: null },
    ]);
    // summary rows are skipped loudly, never silently
    expect(res.warnings).toEqual(['Row 6 ("Totals") skipped as summary row.']);
  });

  it('parses single-balance + prior-year columns', () => {
    const buf = syntheticEtbXlsx([
      ['N/C', 'Name', 'Final Balance', 'Prior Year'],
      ['7100', 'Audit fees', 1500, 1400],
      ['4000', 'Turnover', -80000, -70000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts[0]).toEqual({
      accountCode: '7100',
      accountName: 'Audit fees',
      cyBalance: 1500,
      pyBalance: 1400,
    });
  });

  it('rejects a file where no header row can be found', () => {
    const buf = syntheticEtbXlsx([['just', 'some', 'text'], ['more', 'noise', 1]]);
    expect(() => parseEtb(buf)).toThrow(/could not locate an ETB header row/i);
  });

  it('warns when the ETB does not balance to zero', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['1200', 'Bank', 5000],
      ['4000', 'Sales', -4000],
    ]);
    const res = parseEtb(buf);
    expect(res.warnings.some((w) => /does not balance/i.test(w))).toBe(true);
  });

  it('parses accountant-style number strings strictly ((1,234.56) → -1234.56)', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['4000', 'Sales', '(1,234.56)'],
      ['1200', 'Bank', '1,234.56'],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '4000', accountName: 'Sales', cyBalance: -1234.56, pyBalance: null },
      { accountCode: '1200', accountName: 'Bank', cyBalance: 1234.56, pyBalance: null },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('treats a bare "-" as no balance and skips the row with a warning', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['1200', 'Bank', 500],
      ['3500', 'Loan', -500],
      ['9999', 'Suspense', '-'],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toHaveLength(2);
    expect(res.warnings.some((w) => /Suspense.*skipped: no numeric balance/i.test(w))).toBe(true);
  });

  it('applies Dr/Cr suffix signs ("500 Cr" → -500)', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['1200', 'Bank', '500 Dr'],
      ['4000', 'Sales', '500 Cr'],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '1200', accountName: 'Bank', cyBalance: 500, pyBalance: null },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -500, pyBalance: null },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('rejects European decimal-comma values ("1.234,56") instead of corrupting them', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['1200', 'Bank', 500],
      ['3500', 'Loan', -500],
      ['8888', 'Foreign supplier', '1.234,56'],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts.find((a) => a.accountCode === '8888')).toBeUndefined();
    expect(res.warnings.some((w) => /Foreign supplier.*skipped: no numeric balance/i.test(w))).toBe(true);
  });

  it('rejects comma values that are not genuine thousands groups ("1234,56", "1,23")', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['1200', 'Bank', 500],
      ['3500', 'Loan', -500],
      ['8881', 'Foreign supplier A', '1234,56'],
      ['8882', 'Foreign supplier B', '1,23'],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toHaveLength(2);
    expect(res.warnings.some((w) => /Foreign supplier A.*skipped: no numeric balance/i.test(w))).toBe(true);
    expect(res.warnings.some((w) => /Foreign supplier B.*skipped: no numeric balance/i.test(w))).toBe(true);
  });

  it('keeps "Net wages payable" accounts but skips summary rows with a named warning', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['2210', 'Net wages payable', 500],
      ['1200', 'Bank', -500],
      [null, 'Net assets', 0],
      [null, 'Grand Total', 0],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '2210', accountName: 'Net wages payable', cyBalance: 500, pyBalance: null },
      { accountCode: '1200', accountName: 'Bank', cyBalance: -500, pyBalance: null },
    ]);
    expect(res.warnings).toEqual([
      'Row 4 ("Net assets") skipped as summary row.',
      'Row 5 ("Grand Total") skipped as summary row.',
    ]);
  });

  it('ignores opening/brought-forward columns and reads the closing balance', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Name', 'Opening Balance', 'Closing Balance'],
      ['1200', 'Bank', 999, 5000],
      ['3801', 'Share capital', -999, -5000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: null },
      { accountCode: '3801', accountName: 'Share capital', cyBalance: -5000, pyBalance: null },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('throws on genuinely ambiguous balance columns instead of silently picking one', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Name', 'Balance', 'Final Balance'],
      ['1200', 'Bank', 5000, 4000],
      ['3801', 'Share capital', -5000, -4000],
    ]);
    expect(() => parseEtb(buf)).toThrow(/ambiguous balance columns.*"Balance".*"Final Balance"/i);
  });

  it('classifies "Debit Amount"/"Credit Amount" as a Dr/Cr pair, not a balance column', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Name', 'Debit Amount', 'Credit Amount'],
      ['1200', 'Bank', 5000, null],
      ['4000', 'Sales', null, 5000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: null },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -5000, pyBalance: null },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('extracts prior-year Dr/Cr column pairs into pyBalance', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Name', 'Debit', 'Credit', 'PY Debit', 'PY Credit'],
      ['1200', 'Bank', 5000, null, 4000, null],
      ['4000', 'Sales', null, 5000, null, 4000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -5000, pyBalance: -4000 },
    ]);
    expect(res.warnings).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';

const FIX = path.join(__dirname, '..', 'fixtures', 'etb');
const real = fs.existsSync(FIX)
  ? fs.readdirSync(FIX, { recursive: true, encoding: 'utf8' }).filter((f) => /\.xlsx?$/i.test(f))
  : [];

describe.skipIf(real.length === 0)('parseEtb on real corpus ETBs', () => {
  for (const f of real) {
    it(`parses ${f} and balances`, () => {
      const res = parseEtb(fs.readFileSync(path.join(FIX, f)));
      expect(res.accounts.length).toBeGreaterThan(5);
      expect(res.warnings.filter((w) => /does not balance/i.test(w))).toEqual([]);
    });
  }
});
