import { describe, it, expect } from 'vitest';
import { computeTax } from '../src/tax-computation';

describe('computeTax', () => {
  it('runs the full working: profit + add-backs − CA − losses → chargeable income @35%', () => {
    const c = computeTax(100000, {
      depreciationAddBack: 8000,
      capitalAllowancesTotal: 12000,
      lossesBroughtForward: 30000,
    });
    expect(c.totalAddBacks).toBe(8000);
    expect(c.adjustedProfit).toBe(108000);
    expect(c.incomeAfterCapitalAllowances).toBe(96000);
    expect(c.lossesUtilised).toBe(30000);
    expect(c.lossesCarriedForward).toBe(0);
    expect(c.chargeableIncome).toBe(66000);
    expect(c.taxCharge).toBe(23100);
  });

  it('caps loss relief at available income and carries the rest forward', () => {
    const c = computeTax(1000, { lossesBroughtForward: 5000 });
    expect(c.lossesUtilised).toBe(1000);
    expect(c.lossesCarriedForward).toBe(4000);
    expect(c.chargeableIncome).toBe(0);
    expect(c.taxCharge).toBe(0);
    expect(c.notes.join(' ')).toMatch(/carried forward: €4000\.00/);
  });

  it('clamps a current-year loss to zero chargeable income with a carry-forward note', () => {
    const c = computeTax(-5000, {});
    expect(c.chargeableIncome).toBe(0);
    expect(c.taxCharge).toBe(0);
    expect(c.lossesUtilised).toBe(0);
    expect(c.notes.join(' ')).toMatch(/Current-year loss of €5000\.00/);
  });

  it('deducts exempt dividends and skips zero-amount lines', () => {
    const c = computeTax(50000, { dividendsExemptPE: 10000, finesPenaltiesAddBack: 0 });
    expect(c.addBacks).toEqual([]);
    expect(c.deductions).toEqual([
      { id: 'dividendsExemptPE', label: expect.stringMatching(/participation exemption/i), amount: 10000 },
    ]);
    expect(c.adjustedProfit).toBe(40000);
    expect(c.taxCharge).toBe(14000);
  });

  it('includes general provisions/impairments in the add-backs', () => {
    const c = computeTax(20000, { generalProvisionsAddBack: 1500 });
    expect(c.totalAddBacks).toBe(1500);
    expect(c.addBacks).toEqual([
      { id: 'generalProvisionsAddBack', label: expect.stringMatching(/general provisions/i), amount: 1500 },
    ]);
    expect(c.adjustedProfit).toBe(21500);
  });

  it('rejects unknown ids and non-finite amounts — never a silent wrong figure', () => {
    expect(() => computeTax(0, { notAQuestion: 5 })).toThrow(/notAQuestion/);
    expect(() => computeTax(0, { depreciationAddBack: NaN })).toThrow(/invalid amount/i);
  });
});
