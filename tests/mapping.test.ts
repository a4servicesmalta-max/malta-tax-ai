import { describe, it, expect } from 'vitest';
import { applyMapping, proposeMapping, netProfitFromMapping } from '../src/mapping';
import type { EtbAccount, MappingProfile } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: 4000 },
  { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
  { accountCode: '7100', accountName: 'Audit fees', cyBalance: 1500, pyBalance: 1400 },
  { accountCode: '9999', accountName: 'Mystery suspense', cyBalance: 10, pyBalance: null },
];

describe('mapping', () => {
  it('applies a confirmed profile, aggregates by code, surfaces unmapped', () => {
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        { ledgerNameMatch: 'audit', cfrCode: 6173, sheet: 'Income' },
      ],
    };
    const fill = applyMapping(ETB, profile);
    expect(fill.codeCells).toContainEqual({ sheet: 'B_Sheet', cfrCode: 2150, amount: 5000 });
    expect(fill.codeCells).toContainEqual({ sheet: 'Income', cfrCode: 5000, amount: -80000 });
    expect(fill.unmappedAccounts).toEqual([
      { code: '9999', name: 'Mystery suspense', balance: 10 },
    ]);
    // net profit derived from Income-mapped lines: -(-80000 + 1500) = 78500
    expect(netProfitFromMapping(fill)).toBe(78500);
    expect(fill.directCells).toContainEqual({ sheet: 'p3', ref: 'E6', value: 78500 });
  });

  it('heuristic proposal maps recognizable names and prefers prior-year codes', () => {
    const proposed = proposeMapping(ETB, { priorYearCodes: new Set([2150]) });
    const bank = proposed.rules.find((r) => r.ledgerCode === '1200');
    expect(bank).toBeDefined();
    expect(bank!.sheet).toBe('B_Sheet');
    // 0.95 base + 0.05 prior-year boost, capped at 0.99
    expect(bank!.confidence).toBe(0.99);
    // no proposal for the suspense account — must be left for the human
    expect(proposed.rules.find((r) => r.ledgerCode === '9999')).toBeUndefined();
  });

  it('an exact ledgerCode rule wins over an earlier name-match rule', () => {
    const profile: MappingProfile = {
      rules: [
        { ledgerNameMatch: 'bank', cfrCode: 9990, sheet: 'B_Sheet' },
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
      ],
    };
    const fill = applyMapping([ETB[0]], profile);
    expect(fill.codeCells).toEqual([{ sheet: 'B_Sheet', cfrCode: 2150, amount: 5000 }]);
  });
});

// Regression (2026-07-12 test round): an ETB tax-charge account mapped to Income
// code 7060 flowed into E6, making "net profit before tax" an AFTER-tax figure
// (real client: E6 understated by exactly the €290,758 tax charge).
import { netProfitFromMapping as _npbt } from '../src/mapping';
describe('netProfitFromMapping below-the-line exclusion', () => {
  it('excludes the 7060 tax row (and any code >= 7050) from E6', () => {
    const fill = {
      codeCells: [
        { sheet: 'Income' as const, cfrCode: 5000, amount: -100000 },
        { sheet: 'Income' as const, cfrCode: 6173, amount: 20000 },
        { sheet: 'Income' as const, cfrCode: 7060, amount: 28000 },
      ],
    };
    expect(_npbt(fill)).toBe(80000); // before tax — NOT 52,000
  });
});
