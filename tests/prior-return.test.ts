import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
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

  it('cross-check flags filed codes the mapping never produces', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 14, code: 3500, value: 50000 },
      ],
      income: [],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
    ];
    const profile: MappingProfile = {
      rules: [{ ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' }],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toContainEqual({
      sheet: 'B_Sheet',
      cfrCode: 3500,
      priorReturnValue: 50000,
      mappedPyValue: 0,
    });
  });

  it('cross-check aggregates ledger accounts into one filed code and counts excluded accounts', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 4000 }],
      income: [],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank A', cyBalance: 3000, pyBalance: 2500 },
      { accountCode: '1210', accountName: 'Bank B', cyBalance: 2000, pyBalance: 1500 },
      { accountCode: '9999', accountName: 'New this year', cyBalance: 10, pyBalance: null },
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '1210', cfrCode: 2150, sheet: 'B_Sheet' },
      ],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([]);
    expect(res.excludedAccounts).toBe(1);
  });

  it('cross-check surfaces aggregate drift even when every code is within tolerance', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 11, code: 2160, value: 100 },
      ],
      income: [],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000.9 },
      { accountCode: '1300', accountName: 'Petty cash', cyBalance: 120, pyBalance: 100.9 },
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '1300', cfrCode: 2160, sheet: 'B_Sheet' },
      ],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([]);
    expect(res.aggregateDrift).toEqual([
      { sheet: 'B_Sheet', filedTotal: 4100, mappedTotal: 4101.8 },
    ]);
  });

  it('cross-check compares magnitudes for positive-convention prior returns', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 12, code: 3801, value: 4000 }, // all-positive filed return
      ],
      income: [{ row: 5, code: 5000, value: 70000 }],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
      { accountCode: '3000', accountName: 'Retained earnings', cyBalance: -5000, pyBalance: -4000 },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '3000', cfrCode: 3801, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      ],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([]);
    expect(res.checkedCodes).toBe(3);
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
    expect(review.convention).toBe('unknown');
    // actionable: message lists the largest contributing codes
    expect(review.findings[0].message).toContain('2150');
    expect(review.findings[0].message).toContain('3801');
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
    expect(review.convention).toBe('signed');
  });

  it('reviewPriorReturn accepts an all-positive (template-computed) filed return', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 }, // assets (codes < 3000)
        { row: 12, code: 3801, value: 4000 }, // equity & liabilities (codes >= 3000)
      ],
      income: [{ row: 5, code: 5000, value: 70000 }],
    });
    const review = await reviewPriorReturn(prior);
    expect(review.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(review.convention).toBe('positive');
  });

  it('reviewPriorReturn does not warn about value-less code rows (normal on real returns)', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 11, code: 2160 }, // unused row — no value, entirely normal
        { row: 12, code: 3801, value: -4000 },
      ],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const review = await reviewPriorReturn(prior);
    expect(review.findings).toEqual([]);
  });

  it('reviewPriorReturn reports an unsupported template instead of crashing when sheets are missing', async () => {
    const ws = XLSX.utils.aoa_to_sheet([['not a CfR return']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'B_Sheet'); // Income sheet missing
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const review = await reviewPriorReturn(buf);
    expect(review.findings.some((f) => f.severity === 'error' && /unsupported or empty template/i.test(f.message))).toBe(true);
    expect(review.convention).toBe('unknown');
  });
});
