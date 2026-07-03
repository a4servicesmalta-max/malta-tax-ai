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

  it('escapes HTML in every interpolated string, including the mapping sheet', () => {
    const html = renderComputationSummary({
      clientName: 'Evil & Co <script>alert(1)</script>',
      yearOfAssessment: 'YA2026',
      netProfitPerAccounts: 0,
      fills: [],
      mappingRows: [
        {
          ledger: '4000 <script>alert(2)</script> & Sons',
          cfrCode: 5000,
          sheet: '<script>alert(3)</script>',
          amount: -1,
        },
      ],
      warnings: [],
      unmatchedCodes: [],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Evil &amp; Co');
    expect(html).toContain('&amp; Sons');
  });
});
