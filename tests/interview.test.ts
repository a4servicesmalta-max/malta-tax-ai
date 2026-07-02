import { describe, it, expect } from 'vitest';
import { buildInterview, fillsFromAnswers } from '../src/interview';
import type { EtbAccount } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '8000', accountName: 'Depreciation charge', cyBalance: 3000, pyBalance: 2500 },
  { accountCode: '8100', accountName: 'Fines and penalties', cyBalance: 200, pyBalance: null },
  { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
];

describe('interview', () => {
  it('triggers depreciation add-back with the ETB figure pre-answered', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    const dep = iv.questions.find((q) => q.id === 'depreciationAddBack');
    expect(dep).toBeDefined();
    expect(dep!.preAnswer).toBe(3000);
    expect(dep!.legalBasis).toMatch(/Cap\. 123/);
  });

  it('triggers fines add-back and always asks losses b/f when no prior return', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    expect(iv.questions.some((q) => q.id === 'finesPenaltiesAddBack')).toBe(true);
    expect(iv.questions.some((q) => q.id === 'lossesBroughtForward')).toBe(true);
  });

  it('does not trigger questions with no basis in the ETB', () => {
    const iv = buildInterview(
      [{ accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: null }],
      { hasPriorReturn: false }
    );
    expect(iv.questions.some((q) => q.id === 'depreciationAddBack')).toBe(false);
  });

  it('converts confirmed answers into anchored or manual fills, skipping zeros', () => {
    const fills = fillsFromAnswers({ depreciationAddBack: 3000, lossesBroughtForward: 0 });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ amount: 3000, label: expect.stringMatching(/depreciation/i) });
    // anchor not yet surveyed -> manual entry
    expect(fills[0].anchorId).toBeNull();
  });
});
