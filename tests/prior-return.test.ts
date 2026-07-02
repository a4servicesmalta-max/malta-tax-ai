import { describe, it, expect } from 'vitest';
import { readPriorReturn, priorYearCrossCheck, reviewPriorReturn } from '../src/prior-return';
import { syntheticCfrWorkbook } from './helpers/synthetic';
import type { EtbAccount, MappingProfile } from '../src/domain';

describe('prior-return', () => {
  it('extracts the code set and values from a filed prior return', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 4000 }],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const info = await readPriorReturn(prior);
    expect(info.codes.has(2150)).toBe(true);
    expect(info.values).toContainEqual({ sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: 4000 });
  });

  it('cross-check passes when PY balances mapped reproduce the prior return', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 4000 }],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      ],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([]);
    expect(res.checkedCodes).toBe(2);
  });

  it('cross-check reports per-code mismatches', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 9999 }],
      income: [],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
    ];
    const profile: MappingProfile = {
      rules: [{ ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' }],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([
      { sheet: 'B_Sheet', cfrCode: 2150, priorReturnValue: 9999, mappedPyValue: 4000 },
    ]);
  });

  it('reviewPriorReturn flags a non-balancing balance sheet and echoes continuity values', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 }, // asset Dr
        { row: 12, code: 3801, value: -3000 }, // equity Cr — doesn't offset 4000
      ],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const review = await reviewPriorReturn(prior);
    expect(review.findings.some((f) => /balance sheet.*does not balance/i.test(f.message))).toBe(true);
    expect(review.findings[0].severity).toBe('error');
  });

  it('reviewPriorReturn passes a clean return', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 12, code: 3801, value: -4000 },
      ],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const review = await reviewPriorReturn(prior);
    expect(review.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});
