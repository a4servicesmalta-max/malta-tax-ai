import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { fillCfrReturn } from '../src/template-writer';
import { syntheticCfrWorkbook } from './helpers/synthetic';

describe('fillCfrReturn', () => {
  it('writes amounts into column E of the row matching each CfR code', async () => {
    const tpl = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150 },
        { row: 11, code: 3801 },
      ],
      income: [{ row: 5, code: 5000 }],
    });
    const { buffer, unmatched } = await fillCfrReturn(
      tpl,
      [
        { sheet: 'B_Sheet', cfrCode: 2150, amount: 1234.56 },
        { sheet: 'B_Sheet', cfrCode: 3801, amount: -1000 },
        { sheet: 'Income', cfrCode: 5000, amount: -50000 },
      ],
      [{ sheet: 'p3', ref: 'E6', value: 42000 }]
    );
    expect(unmatched).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    const b = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(b).toContain('<c r="E10"><v>1234.56</v></c>');
    expect(b).toContain('<c r="E11"><v>-1000</v></c>');
    // formulas untouched
    expect(b).toContain('<f>SUM(E10)</f>');
    const p3 = await zip.file('xl/worksheets/sheet3.xml')!.async('string');
    expect(p3).toContain('<c r="E6"><v>42000</v></c>');
    // recalc-on-open set
    const wb = await zip.file('xl/workbook.xml')!.async('string');
    expect(wb).toContain('fullCalcOnLoad="1"');
  });

  it('reports unmatched codes instead of silently dropping them', async () => {
    const tpl = await syntheticCfrWorkbook({ bSheet: [{ row: 10, code: 2150 }], income: [] });
    const { unmatched } = await fillCfrReturn(tpl, [
      { sheet: 'B_Sheet', cfrCode: 9999, amount: 5 },
    ]);
    expect(unmatched).toEqual([{ sheet: 'B_Sheet', cfrCode: 9999 }]);
  });
});
