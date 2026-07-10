import { describe, it, expect } from 'vitest';
import { computeRefund } from '../src/refund-computation';

describe('shareholder refund working (ITMA Cap. 372 Art. 48(4)/(4A))', () => {
  it('applies the standard 6/7 fraction', () => {
    const r = computeRefund(35000, 'standard');
    expect(r.fraction).toBeCloseTo(6 / 7, 10);
    expect(r.refundAmount).toBe(30000);
  });

  it('applies the 5/7 fraction for passive interest/royalties', () => {
    const r = computeRefund(35000, 'passiveInterestRoyalties');
    expect(r.fraction).toBeCloseTo(5 / 7, 10);
    expect(r.refundAmount).toBe(25000);
  });

  it('applies the 2/3 fraction when DTR was claimed on FIA profits', () => {
    const r = computeRefund(35000, 'dtrClaimed');
    expect(r.fraction).toBeCloseTo(2 / 3, 10);
    expect(r.refundAmount).toBe(23333.33);
  });

  it('applies a 100% fraction for a participating holding taxed (not exempted)', () => {
    const r = computeRefund(35000, 'participatingHolding100');
    expect(r.fraction).toBe(1);
    expect(r.refundAmount).toBe(35000);
  });

  it('rounds the refund amount to 2 decimal places', () => {
    const r = computeRefund(100, 'dtrClaimed');
    expect(r.refundAmount).toBe(66.67);
  });

  it('cites ITMA art. 48(4)/(4A) and the 4 preconditions plus the 4-year claim window', () => {
    const r = computeRefund(1000, 'standard');
    expect(r.notes.join(' ')).toMatch(/ITMA \(Cap\. 372\) Art\. 48\(4\)/);
    expect(r.notes.join(' ')).toMatch(/dividend certificate/i);
    expect(r.notes.join(' ')).toMatch(/4 years/);
  });

  it('notes that refunds never attach to FTA/IPA/UA distributions', () => {
    const r = computeRefund(1000, 'standard');
    expect(r.notes.join(' ')).toMatch(/Final Tax Account/);
    expect(r.notes.join(' ')).toMatch(/never/i);
  });

  it('carries the category and taxPaid through unchanged', () => {
    const r = computeRefund(12345.67, 'passiveInterestRoyalties');
    expect(r.category).toBe('passiveInterestRoyalties');
    expect(r.taxPaid).toBe(12345.67);
  });
});
