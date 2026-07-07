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

  it('writes description text as an escaped inline string, inserted in column order', async () => {
    const tpl = await syntheticCfrWorkbook({ bSheet: [], income: [] });
    const { buffer } = await fillCfrReturn(
      tpl,
      [],
      [
        { sheet: 'p3', ref: 'E6', value: 1200 },
        { sheet: 'p3', ref: 'B6', value: 'Add back: fines & <penalties>' },
      ]
    );
    const zip = await JSZip.loadAsync(buffer);
    const p3 = await zip.file('xl/worksheets/sheet3.xml')!.async('string');
    expect(p3).toContain(
      '<c r="B6" t="inlineStr"><is><t xml:space="preserve">Add back: fines &amp; &lt;penalties&gt;</t></is></c>'
    );
    expect(p3).toContain('<c r="E6"><v>1200</v></c>');
    expect(p3.indexOf('r="B6"')).toBeLessThan(p3.indexOf('r="E6"'));
  });

  it('reports unmatched codes instead of silently dropping them', async () => {
    const tpl = await syntheticCfrWorkbook({ bSheet: [{ row: 10, code: 2150 }], income: [] });
    const { unmatched } = await fillCfrReturn(tpl, [
      { sheet: 'B_Sheet', cfrCode: 9999, amount: 5 },
    ]);
    expect(unmatched).toEqual([{ sheet: 'B_Sheet', cfrCode: 9999 }]);
  });

  it('does not corrupt rows whose formulas contain $ replacement patterns', async () => {
    const tpl = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, formula: 'SUM($E$10:$E$12)' }],
      income: [],
    });
    const { buffer, unmatched } = await fillCfrReturn(tpl, [
      { sheet: 'B_Sheet', cfrCode: 2150, amount: 777 },
    ]);
    expect(unmatched).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    const b = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    // absolute-reference formula must survive byte-intact
    expect(b).toContain('<f>SUM($E$10:$E$12)</f>');
    expect(b).toContain('<c r="E10"><v>777</v></c>');
  });

  it('writes into an x:-prefixed OOXML template with matching prefixed markup', async () => {
    const tpl = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150 }],
      income: [],
      prefixed: true,
    });
    const { buffer, unmatched } = await fillCfrReturn(tpl, [
      { sheet: 'B_Sheet', cfrCode: 2150, amount: 1234.56 },
    ]);
    expect(unmatched).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    const b = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(b).toContain('<x:c r="E10"><x:v>1234.56</x:v></x:c>');
    const wb = await zip.file('xl/workbook.xml')!.async('string');
    expect(wb).toContain('fullCalcOnLoad="1"');
  });
});

describe('fillCfrReturn — stale residue clearing', () => {
  it('blanks typed values on cleared rows while writes land, keeping the cell and formulas', async () => {
    const tpl = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 999 }, // stale preparer figure — must be blanked
        { row: 11, code: 3801 },
      ],
      income: [],
    });
    const { buffer, unmatched } = await fillCfrReturn(
      tpl,
      [{ sheet: 'B_Sheet', cfrCode: 3801, amount: -500 }],
      [],
      [{ sheet: 'B_Sheet', cfrCode: 2150 }]
    );
    expect(unmatched).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    const b = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(b).toContain('<c r="E10"/>'); // value gone, cell (and style slot) kept
    expect(b).not.toContain('<v>999</v>');
    expect(b).toContain('<c r="E11"><v>-500</v></c>');
    expect(b).toContain('<f>SUM(E10)</f>'); // formulas untouched
  });

  it('ignores clear targets with no matching row instead of reporting unmatched', async () => {
    const tpl = await syntheticCfrWorkbook({ bSheet: [{ row: 10, code: 2150 }], income: [] });
    const { unmatched } = await fillCfrReturn(tpl, [], [], [{ sheet: 'B_Sheet', cfrCode: 9999 }]);
    expect(unmatched).toEqual([]);
  });
});
