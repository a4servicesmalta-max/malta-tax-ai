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

  it('excludes accumulated depreciation from the add-back pre-answer', () => {
    const iv = buildInterview(
      [
        { accountCode: '8000', accountName: 'Depreciation charge', cyBalance: 3000, pyBalance: null },
        { accountCode: '0031', accountName: 'Accumulated depreciation', cyBalance: -15000, pyBalance: null },
      ],
      { hasPriorReturn: false }
    );
    const dep = iv.questions.find((q) => q.id === 'depreciationAddBack');
    expect(dep).toBeDefined();
    expect(dep!.preAnswer).toBe(3000);
    // provenance carries "<code> <name>" so the preparer sees why the question fired
    expect(dep!.triggeredBy).toEqual(['8000 Depreciation charge']);
  });

  it('excludes provisions from amount triggers and dividends payable from the PE trigger', () => {
    const iv = buildInterview(
      [
        { accountCode: '2100', accountName: 'Provision for depreciation', cyBalance: -9000, pyBalance: null },
        { accountCode: '3200', accountName: 'Dividends payable', cyBalance: -4000, pyBalance: null },
        { accountCode: '3210', accountName: 'Proposed dividend', cyBalance: -2000, pyBalance: null },
      ],
      { hasPriorReturn: false }
    );
    expect(iv.questions.some((q) => q.id === 'depreciationAddBack')).toBe(false);
    expect(iv.questions.some((q) => q.id === 'dividendsExemptPE')).toBe(false);
  });

  it('nulls the pre-answer when netted hits contradict the expected sign', () => {
    const iv = buildInterview(
      [
        { accountCode: '7900', accountName: 'Unrealised exchange loss', cyBalance: 300, pyBalance: null },
        { accountCode: '7901', accountName: 'Unrealised exchange gain', cyBalance: -500, pyBalance: null },
      ],
      { hasPriorReturn: false }
    );
    const fx = iv.questions.find((q) => q.id === 'unrealizedFxAddBack');
    expect(fx).toBeDefined();
    // net −200 is a Cr while the add-back expects Dr → manual entry, never a fabricated 800
    expect(fx!.preAnswer).toBeNull();
  });

  it('pre-answers dividend income (Cr) as a positive amount', () => {
    const iv = buildInterview(
      [{ accountCode: '4900', accountName: 'Dividend income', cyBalance: -10000, pyBalance: null }],
      { hasPriorReturn: false }
    );
    const div = iv.questions.find((q) => q.id === 'dividendsExemptPE');
    expect(div).toBeDefined();
    expect(div!.preAnswer).toBe(10000);
  });

  it('fillsFromAnswers rejects non-finite amounts and unknown ids, keeps 0-skip and negatives', () => {
    expect(() => fillsFromAnswers({ depreciationAddBack: NaN })).toThrow(
      /invalid amount for interview answer "depreciationAddBack"/i
    );
    expect(() => fillsFromAnswers({ notARealQuestion: 100 })).toThrow(/notARealQuestion/);
    expect(fillsFromAnswers({ finesPenaltiesAddBack: 0 })).toEqual([]);
    const fills = fillsFromAnswers({ unrealizedFxAddBack: -500 });
    expect(fills).toHaveLength(1);
    expect(fills[0].amount).toBe(-500);
  });
});
