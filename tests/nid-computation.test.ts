import { describe, it, expect } from 'vitest';
import { computeNid } from '../src/nid-computation';

describe('Notional Interest Deduction working (S.L. 123.176)', () => {
  it('computes the gross deduction as referenceRate * riskCapital when under the cap', () => {
    const n = computeNid(0.0919, 100000, 50000);
    expect(n.grossDeduction).toBe(9190);
    expect(n.cap).toBe(45000); // 90% of 50000
    expect(n.allowedDeduction).toBe(9190);
    expect(n.carriedForward).toBe(0);
  });

  it('caps the allowed deduction at 90% of chargeable income before NID, carrying the excess forward', () => {
    const n = computeNid(0.0919, 1000000, 50000);
    expect(n.grossDeduction).toBe(91900);
    expect(n.cap).toBe(45000);
    expect(n.allowedDeduction).toBe(45000);
    expect(n.carriedForward).toBe(46900);
  });

  it('treats a negative/zero chargeable income base as a zero cap (no deduction allowed, full carry-forward)', () => {
    const n = computeNid(0.0919, 100000, -5000);
    expect(n.cap).toBe(0);
    expect(n.allowedDeduction).toBe(0);
    expect(n.carriedForward).toBe(n.grossDeduction);
  });

  it('never hardcodes the reference rate — it is echoed back exactly as passed in', () => {
    const n = computeNid(0.0725, 1, 1);
    expect(n.referenceRate).toBe(0.0725);
  });

  it('flags the all-shareholders approval requirement and the 110% FTA allocation as non-computable facts', () => {
    const n = computeNid(0.0919, 100000, 50000);
    expect(n.notes.join(' ')).toMatch(/approval of ALL shareholders/i);
    expect(n.notes.join(' ')).toMatch(/110%/);
    expect(n.notes.join(' ')).toMatch(/Final Tax Account/);
  });

  it('notes the carry-forward amount only when there is one', () => {
    const capped = computeNid(0.0919, 1000000, 50000);
    expect(capped.notes.some((x) => x.includes('exceeds the 90% cap'))).toBe(true);
    const uncapped = computeNid(0.0919, 100000, 50000);
    expect(uncapped.notes.some((x) => x.includes('exceeds the 90% cap'))).toBe(false);
  });

  it('marks the working as claimed and never auto-anchors to TRA100', () => {
    const n = computeNid(0.0919, 100000, 50000);
    expect(n.claimed).toBe(true);
    expect(n.notes.join(' ')).toMatch(/TRA100/);
    expect(n.notes.join(' ')).toMatch(/manually/i);
  });
});
