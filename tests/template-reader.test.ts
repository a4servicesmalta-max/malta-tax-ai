import { describe, it, expect } from 'vitest';
import { readCfrValues, listSheetNames } from '../src/template-reader';
import { syntheticCfrWorkbook } from './helpers/synthetic';

describe('template-reader', () => {
  it('lists sheet names', async () => {
    const wb = await syntheticCfrWorkbook({ bSheet: [], income: [] });
    expect(await listSheetNames(wb)).toEqual(['B_Sheet', 'Income', 'p3', 'p4']);
  });

  it('reads (code, value) pairs from requested sheets', async () => {
    const wb = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 111.5 },
        { row: 11, code: 3801 }, // no E value -> null
      ],
      income: [{ row: 5, code: 5000, value: -9000 }],
    });
    const vals = await readCfrValues(wb, ['B_Sheet', 'Income']);
    expect(vals).toEqual([
      { sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: 111.5 },
      { sheet: 'B_Sheet', cfrCode: 3801, row: 11, value: null },
      { sheet: 'Income', cfrCode: 5000, row: 5, value: -9000 },
    ]);
  });

  it('skips shared-string cells in both the code and value columns', async () => {
    const wb = await syntheticCfrWorkbook({
      bSheet: [
        // C7 is a shared-string label (t="s", <v> is a string-table index) -> not a CfR code
        { row: 7, code: 12, codeT: 's' },
        // real code row, but E10 holds a shared-string index -> value must be null
        { row: 10, code: 2150, value: 3, valueT: 's' },
        { row: 11, code: 3801, value: 500 },
      ],
      income: [],
    });
    const vals = await readCfrValues(wb, ['B_Sheet']);
    expect(vals).toEqual([
      { sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: null },
      { sheet: 'B_Sheet', cfrCode: 3801, row: 11, value: 500 },
    ]);
  });

  it('parses scientific notation with negative exponents and negative values', async () => {
    const wb = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: '2.5E-5' },
        { row: 11, code: 3801, value: -1234.5 },
      ],
      income: [],
    });
    const vals = await readCfrValues(wb, ['B_Sheet']);
    expect(vals).toEqual([
      { sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: 2.5e-5 },
      { sheet: 'B_Sheet', cfrCode: 3801, row: 11, value: -1234.5 },
    ]);
  });

  it('reads an x:-prefixed OOXML workbook', async () => {
    const wb = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 111.5 }],
      income: [],
      prefixed: true,
    });
    expect(await listSheetNames(wb)).toEqual(['B_Sheet', 'Income', 'p3', 'p4']);
    const vals = await readCfrValues(wb, ['B_Sheet']);
    expect(vals).toEqual([{ sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: 111.5 }]);
  });

  it('throws on unknown sheet names instead of silently skipping', async () => {
    const wb = await syntheticCfrWorkbook({ bSheet: [], income: [] });
    await expect(readCfrValues(wb, ['Nope'])).rejects.toThrow(
      'Sheet "Nope" not found in workbook'
    );
  });
});
