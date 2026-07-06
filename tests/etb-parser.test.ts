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

  it('parses an extended TB with year-numbered closing columns, skipping the repeated header', () => {
    const buf = syntheticEtbXlsx([
      ['n/c', 'ACCOUNT DESCRIPTION', 'Client TB', 'Adjustments', 2024, 'P/B', 2023],
      [null, null, '€', '€', '€', null, '€'],
      ['N/C', 'Account Description', 'Client TB', 'Adjustments', 2024, 'P/B', 2023],
      ['0500', 'Equipment', 606084, -1, 606083, 'B', 604706],
      ['4000', 'Sales', -700000, 0, -700000, 'P', -650000],
      ['5000', 'Purchases', 93917, 0, 93917, 'P', 45294],
    ]);
    const res = parseEtb(buf);
    // year columns (max=CY, next=PY) supersede the pre-adjustment "Client TB" column
    expect(res.accounts).toEqual([
      { accountCode: '0500', accountName: 'Equipment', cyBalance: 606083, pyBalance: 604706, statement: 'BS' },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -700000, pyBalance: -650000, statement: 'PL' },
      { accountCode: '5000', accountName: 'Purchases', cyBalance: 93917, pyBalance: 45294, statement: 'PL' },
    ]);
    expect(res.warnings).toContain('Row 3 ("Account Description") skipped as repeated header row.');
  });

  it('parses a bare Dr/Cr TB with combined "code name" cells and no description header', () => {
    const buf = syntheticEtbXlsx([
      ['FreeHour Limited', null, null],
      ['Trial Balance', null, null],
      [null, 'Debit', 'Credit'],
      ['0002000 BOV Bank', 71780.01, null],
      ['0004000 BOV Overdraft', null, 3891.87],
      ['4000000 Sales', null, 67888.14],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '0002000', accountName: 'BOV Bank', cyBalance: 71780.01, pyBalance: null },
      { accountCode: '0004000', accountName: 'BOV Overdraft', cyBalance: -3891.87, pyBalance: null },
      { accountCode: '4000000', accountName: 'Sales', cyBalance: -67888.14, pyBalance: null },
    ]);
  });

  it('parses the firm audit-file ETB layout ("Final Balance <year>" text columns)', () => {
    // Mirrors the A4 audit workbook ETB sheet: A/c | Details | Clients Balance |
    // Ref | Adj | Final Balance 2022 | P&L | Balance Sheet | Final Balance 2021.
    const buf = syntheticEtbXlsx([
      ['M Client Limited', null, null, null, null, null, null, null, null],
      ['A/c', 'Details', 'Clients Balance', 'Ref', 'Adj', 'Final Balance 2022', 'Profit & Loss', 'Balance Sheet', 'Final Balance 2021'],
      [20, 'Computers equipment', 1072, 'AA10', 212, 1284, null, 1284, 1072],
      [21, 'Computers depreciation', -268, 'AA6', -480, -748, null, -748, -268],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '20', accountName: 'Computers equipment', cyBalance: 1284, pyBalance: 1072, statement: 'BS' },
      { accountCode: '21', accountName: 'Computers depreciation', cyBalance: -748, pyBalance: -268, statement: 'BS' },
    ]);
  });

  it('parses a name + numeric year columns TB (no codes, no Dr/Cr)', () => {
    const buf = syntheticEtbXlsx([
      ['Account Description', 2023, 'P/B', 'P/L', 'B/S', 2022],
      ['Audit Fees', 1450, 'P', 1450, 0, 1650],
      ['Revenue', -9000, 'P', -9000, 0, -10200],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts.map((a) => [a.accountName, a.cyBalance, a.pyBalance])).toEqual([
      ['Audit Fees', 1450, 1650],
      ['Revenue', -9000, -10200],
    ]);
  });

  it('parses a Sage two-row header TB, preferring the final-balances column over interim Dr/Cr', () => {
    const buf = syntheticEtbXlsx([
      ['Client Ltd', null, null, null, null, null],
      [null, null, null, 'Balances as at 31.10.2023', 'Movements', 'Final Balances 2023'],
      ['N/C', 'Name', 'DR', null, null, null],
      ['0030', 'Office Equipment', 1852.94, 1852.94, 0, 1852.94],
      ['1100', 'Debtors Control Account', 739435.09, 739435.09, null, 79219.2],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '0030', accountName: 'Office Equipment', cyBalance: 1852.94, pyBalance: null },
      { accountCode: '1100', accountName: 'Debtors Control Account', cyBalance: 79219.2, pyBalance: null },
    ]);
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
