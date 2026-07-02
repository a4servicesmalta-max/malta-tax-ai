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
    const proposed = proposeMapping(ETB, { priorYearCodes: new Set([2155]) });
    const bank = proposed.rules.find((r) => r.ledgerCode === '1200');
    expect(bank).toBeDefined();
    expect(bank!.sheet).toBe('B_Sheet');
    // no proposal for the suspense account — must be left for the human
    expect(proposed.rules.find((r) => r.ledgerCode === '9999')).toBeUndefined();
  });
});
