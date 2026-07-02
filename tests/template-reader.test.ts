import { describe, it, expect } from 'vitest';
import { readCfrValues, listSheetNames } from '../src/template-reader';
import { syntheticCfrWorkbook } from './helpers/synthetic';

describe('template-reader', () => {
  it('lists sheet names', async () => {
    const wb = await syntheticCfrWorkbook({ bSheet: [], income: [] });
    expect(await listSheetNames(wb)).toEqual(['B_Sheet', 'Income', 'p3']);
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
});
