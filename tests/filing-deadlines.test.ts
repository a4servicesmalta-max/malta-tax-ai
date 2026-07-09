import { describe, it, expect } from 'vitest';
import { filingDeadlineLines } from '../src/filing-deadlines';

describe('filingDeadlineLines', () => {
  it('YA2026, no FY end given: falls back to the 31 Dec row plus an other-year-ends pointer', () => {
    const lines = filingDeadlineLines('2026');
    expect(lines.join(' ')).toContain('30 September 2026');
    expect(lines.join(' ')).toContain('27 November 2026');
    expect(lines.join(' ')).toContain('Other year-ends');
    expect(lines.join(' ')).toContain('9 months after the financial year end');
    expect(lines.join(' ')).toContain('does NOT extend the payment deadline');
    expect(lines.join(' ')).toContain('€50');
  });

  it('YA2025, FY end 30 Sep 2024: matches the September row (29 August 2025 electronic)', () => {
    const lines = filingDeadlineLines('2025', new Date(2024, 8, 30));
    expect(lines.join(' ')).toContain('30 June 2025');
    expect(lines.join(' ')).toContain('29 August 2025');
    expect(lines.join(' ')).not.toContain('Other year-ends');
  });

  it('unknown YA: returns only the statutory-rule/payment lines plus a check-mtca note', () => {
    const lines = filingDeadlineLines('2027');
    expect(lines.length).toBe(3);
    expect(lines.join(' ')).toContain('9 months after the financial year end');
    expect(lines.join(' ')).toContain('does NOT extend the payment deadline');
    expect(lines.join(' ')).toContain('mtca.gov.mt');
    expect(lines.join(' ')).not.toContain('30 September 2026');
  });

  it('format tolerance: "YA 2026", "YA2026" and "2026" are equivalent', () => {
    const base = filingDeadlineLines('2026', new Date(2025, 11, 31));
    expect(filingDeadlineLines('YA2026', new Date(2025, 11, 31))).toEqual(base);
    expect(filingDeadlineLines('YA 2026', new Date(2025, 11, 31))).toEqual(base);
  });
});
