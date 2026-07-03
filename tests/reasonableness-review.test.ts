import { describe, it, expect, vi } from 'vitest';
import { reasonablenessReview } from '../src/reasonableness-review';
import { computeTax } from '../src/tax-computation';
import type { EtbAccount } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '8000', accountName: 'Depreciation charge', cyBalance: 8000, pyBalance: null },
  { accountCode: '4000', accountName: 'Sales', cyBalance: -200000, pyBalance: null },
];
const COMP = computeTax(50000, {}); // no depreciation add-back despite the charge

const reply = (obj: unknown) => async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('reasonablenessReview', () => {
  it('is unavailable (never throws, no findings) when no credentials are configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    try {
      const r = await reasonablenessReview(ETB, COMP, { apiKey: undefined });
      expect(r.available).toBe(false);
      expect(r.findings).toEqual([]);
      expect(r.note).toMatch(/not configured/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns validated findings from the model', async () => {
    const r = await reasonablenessReview(ETB, COMP, {
      apiKey: 'test',
      createMessage: reply({
        findings: [
          { severity: 'warning', message: 'Depreciation charged (€8,000) but no add-back in the computation.' },
          { severity: 'info', message: 'Confirm entertainment treatment.' },
        ],
      }),
    });
    expect(r.available).toBe(true);
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0].severity).toBe('warning');
  });

  it('drops malformed findings and caps message length', async () => {
    const r = await reasonablenessReview(ETB, COMP, {
      apiKey: 'test',
      createMessage: reply({
        findings: [
          { severity: 'critical', message: 'bad severity' }, // dropped
          { severity: 'warning', message: '' }, // empty dropped
          { severity: 'info', message: 'x'.repeat(1000) }, // kept, trimmed
          { message: 'no severity' }, // dropped
        ],
      }),
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].message.length).toBe(500);
  });

  it('never throws on non-JSON model output — reports unavailable instead', async () => {
    const r = await reasonablenessReview(ETB, COMP, {
      apiKey: 'test',
      createMessage: async () => ({ content: [{ type: 'text', text: 'I refuse to answer as JSON.' }] }),
    });
    expect(r.available).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.note).toMatch(/service error/i);
  });

  it('never produces a figure — the model only returns prose findings', async () => {
    // Even if the model tries to smuggle an amount, findings carry only text.
    const r = await reasonablenessReview(ETB, COMP, {
      apiKey: 'test',
      createMessage: reply({ findings: [{ severity: 'warning', message: 'Enter 8000 on field 2a' }] }),
    });
    expect(r.findings[0]).toEqual({ severity: 'warning', message: 'Enter 8000 on field 2a' });
    expect(Object.keys(r.findings[0])).toEqual(['severity', 'message']); // no amount field reaches the return
  });
});
