import { describe, it, expect } from 'vitest';
import { renderComputationSummary } from '../src/computation-summary';
import { computeTax } from '../src/tax-computation';
import { computeRefund } from '../src/refund-computation';
import { computeNid } from '../src/nid-computation';

describe('computation summary', () => {
  it('renders the tax computation, adjustments, manual-entry flags and provenance', () => {
    const html = renderComputationSummary({
      clientName: 'Test Client Ltd',
      yearOfAssessment: 'YA2026',
      netProfitPerAccounts: 78500,
      computation: computeTax(78500, { depreciationAddBack: 3000, lossesBroughtForward: 1200 }),
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
    // full working paper: adjusted 81,500 − losses 1,200 → chargeable 80,300 @35% = 28,105
    expect(html).toContain('Chargeable income');
    expect(html).toContain('80,300.00');
    expect(html).toContain('28,105.00');
  });

  it('escapes HTML in every interpolated string, including the mapping sheet', () => {
    const html = renderComputationSummary({
      clientName: 'Evil & Co <script>alert(1)</script>',
      yearOfAssessment: 'YA2026',
      netProfitPerAccounts: 0,
      computation: computeTax(0, {}),
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

  it('omits the refund/NID sections entirely when not supplied', () => {
    const html = renderComputationSummary({
      clientName: 'X', yearOfAssessment: 'YA2026', netProfitPerAccounts: 0,
      computation: computeTax(0, {}), fills: [], mappingRows: [], warnings: [], unmatchedCodes: [],
    });
    expect(html).not.toContain('Shareholder refund working');
    expect(html).not.toContain('Notional Interest Deduction working');
  });

  it('renders the shareholder refund working, clearly labelled as guidance only', () => {
    const html = renderComputationSummary({
      clientName: 'X', yearOfAssessment: 'YA2026', netProfitPerAccounts: 0,
      computation: computeTax(0, {}), fills: [], mappingRows: [], warnings: [], unmatchedCodes: [],
      refund: computeRefund(35000, 'dtrClaimed'),
    });
    expect(html).toContain('Shareholder refund working (not filed automatically — preparer confirms preconditions and files the claim)');
    expect(html).toContain('dtrClaimed');
    expect(html).toContain('23,333.33');
    expect(html).toMatch(/ITMA \(Cap\. 372\) Art\. 48\(4\)/);
    expect(html).not.toContain('Notional Interest Deduction working');
  });

  it('renders the NID working, clearly labelled that TRA100 is manual', () => {
    const html = renderComputationSummary({
      clientName: 'X', yearOfAssessment: 'YA2026', netProfitPerAccounts: 0,
      computation: computeTax(0, {}), fills: [], mappingRows: [], warnings: [], unmatchedCodes: [],
      nid: computeNid(0.0919, 100000, 50000),
    });
    expect(html).toContain('Notional Interest Deduction working (NID) — TRA100 must be completed manually; not auto-filed');
    expect(html).toContain('9.19%');
    expect(html).toContain('9,190.00');
    expect(html).not.toContain('Shareholder refund working');
  });
});
