import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { extractFsFigures, tieCheck, extractApprovalDate, extractFiguresFromText } from '../src/fs-tie-check';
import { syntheticEtbXlsx } from './helpers/synthetic';

describe('extractApprovalDate', () => {
  it('takes the board-approval date, not an embedded accounting year-end', () => {
    // Regression: the sentence carries BOTH the period-end and the approval date.
    expect(
      extractApprovalDate(
        'The financial statements were approved by the board for the year ended 31 December 2024 on 27 October 2025 and signed.'
      )
    ).toBe('2025-10-27');
  });
  it('reads the canonical "authorised for issue ... on 27th October 2025" phrasing', () => {
    expect(
      extractApprovalDate('approved and authorised for issue by the board of directors on 27th October 2025 and were signed by')
    ).toBe('2025-10-27');
  });
  it('reads a numeric approval date', () => {
    expect(extractApprovalDate('signed on 05/11/2025')).toBe('2025-11-05');
  });
});

describe('FS net-profit label', () => {
  it('prefers "profit before tax" over "profit for the year" (ties to field 1a)', () => {
    // Field 1a (p3!E6) is net profit BEFORE tax, so the before-tax FS figure is
    // the correct comparand — the after-tax line differs by the tax charge.
    const fig = extractFiguresFromText('Profit before tax 100000\nTax 35000\nProfit for the year 65000');
    expect(fig.netProfit).toBe(100000);
  });
});

function multiSheetXlsx(sheets: Array<{ name: string; rows: (string | number | null)[][] }>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('fs-tie-check', () => {
  it('extracts net profit and total assets from an FS workbook by label', () => {
    const buf = syntheticEtbXlsx([
      ['Statement of comprehensive income', null],
      ['Profit for the year', 78500],
      ['Statement of financial position', null],
      ['Total assets', 120000],
    ]);
    const figs = extractFsFigures(buf);
    expect(figs.netProfit).toBe(78500);
    expect(figs.totalAssets).toBe(120000);
  });

  it('skips leading note-reference columns when picking the figure', () => {
    const buf = syntheticEtbXlsx([
      ['Statement of financial position', null, null, null],
      ['Total assets', 12, 120000, 100000],
    ]);
    expect(extractFsFigures(buf).totalAssets).toBe(120000);
  });

  it('recognises loss-year labels', () => {
    const buf = syntheticEtbXlsx([['Loss for the year', -5000]]);
    expect(extractFsFigures(buf).netProfit).toBe(-5000);
    const buf2 = syntheticEtbXlsx([['(Loss) for the year', -7000]]);
    expect(extractFsFigures(buf2).netProfit).toBe(-7000);
  });

  it('prefers income-statement sheets and ignores non-anchored note text', () => {
    const buf = multiSheetXlsx([
      {
        name: 'Notes',
        rows: [
          ['the net profit margin', 45],
          ['Net profit', 999],
        ],
      },
      { name: 'Income statement', rows: [['Profit for the year', 78500]] },
    ]);
    expect(extractFsFigures(buf).netProfit).toBe(78500);
  });

  it('passes when ETB-derived figures tie within €1', () => {
    const res = tieCheck({ netProfit: 78500, totalAssets: 120000 }, { netProfit: 78500.4, totalAssets: 120000 });
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.checks).toEqual({ netProfit: 'tied', totalAssets: 'tied' });
  });

  it('reports differences when figures do not tie', () => {
    const res = tieCheck({ netProfit: 78500, totalAssets: 120000 }, { netProfit: 70000, totalAssets: 120000 });
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toMatch(/net profit/i);
    expect(res.issues[0]).toContain('8500');
    expect(res.checks.netProfit).toBe('mismatch');
    expect(res.checks.totalAssets).toBe('tied');
  });

  it('surfaces figures that could not be compared instead of passing silently', () => {
    const res = tieCheck({ netProfit: null, totalAssets: 120000 }, { netProfit: 78500, totalAssets: 120000 });
    expect(res.ok).toBe(true); // no mismatch — but the gap must still be visible
    expect(res.checks.netProfit).toBe('not-compared');
    expect(res.checks.totalAssets).toBe('tied');
    expect(res.issues.some((i) => /net profit could not be compared/i.test(i))).toBe(true);
  });
});
