import { describe, it, expect } from 'vitest';
import { renderComputationSummary } from '../src/computation-summary';

describe('computation summary', () => {
  it('renders profit, adjustments, manual-entry flags and provenance', () => {
    const html = renderComputationSummary({
      clientName: 'Test Client Ltd',
      yearOfAssessment: 'YA2026',
      netProfitPerAccounts: 78500,
      fills: [
        { anchorId: null, amount: 3000, label: 'Add back: depreciation/amortisation' },
        { anchorId: 'lossesBroughtForward', amount: 1200, label: 'Deduct: losses brought forward' },
      ],
      mappingRows: [
        { ledger: '4000 Sales', cfrCode: 5000, sheet: 'Income', amount: -80000 },
      ],
      warnings: ['ETB does not balance: net 0.50 (should be 0).'],
      unmatchedCodes: [],
    });
    expect(html).toContain('Test Client Ltd');
    expect(html).toContain('78,500.00');
    expect(html).toContain('MANUAL ENTRY');       // unanchored fill flagged
    expect(html).toContain('depreciation');
    expect(html).toContain('does not balance');
    expect(html).toContain('5000');               // mapping provenance
  });
});
