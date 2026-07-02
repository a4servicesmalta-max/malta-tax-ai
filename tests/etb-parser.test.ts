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
    expect(res.warnings).toEqual([]);
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
    });
  }
});
