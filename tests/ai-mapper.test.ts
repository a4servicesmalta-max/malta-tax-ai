import { describe, it, expect, vi } from 'vitest';
import { proposeMappingAI } from '../src/ai-mapper';
import type { EtbAccount } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: null },
];

describe('ai-mapper', () => {
  it('falls back to heuristics when no API key is configured', async () => {
    const res = await proposeMappingAI(ETB, {}, { apiKey: undefined });
    expect(res.source).toBe('heuristic');
    expect(res.rules.length).toBeGreaterThan(0);
  });

  it('parses a valid model response into proposed rules', async () => {
    const fake = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            rules: [{ ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet', confidence: 0.97 }],
          }),
        },
      ],
    });
    const res = await proposeMappingAI(ETB, {}, { apiKey: 'test', createMessage: fake });
    expect(res.source).toBe('ai');
    expect(res.rules[0]).toMatchObject({ ledgerCode: '1200', cfrCode: 2150 });
  });

  it('falls back to heuristics when the model returns malformed JSON', async () => {
    const fake = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] });
    const res = await proposeMappingAI(ETB, {}, { apiKey: 'test', createMessage: fake });
    expect(res.source).toBe('heuristic');
  });
});
