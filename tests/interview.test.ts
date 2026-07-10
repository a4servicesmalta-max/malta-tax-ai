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

  it('every question carries a boolean required flag', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    expect(iv.questions.length).toBeGreaterThan(0);
    for (const q of iv.questions) expect(typeof q.required).toBe('boolean');
  });

  it('a clean pre-answered question (preAnswer !== null) is required: false', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    const dep = iv.questions.find((q) => q.id === 'depreciationAddBack');
    expect(dep!.preAnswer).not.toBeNull();
    expect(dep!.required).toBe(false);
  });

  it('capitalAllowancesTotal (preAnswer === null, no fixed-asset register) is always required: true', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    const ca = iv.questions.find((q) => q.id === 'capitalAllowancesTotal');
    expect(ca!.preAnswer).toBeNull();
    expect(ca!.required).toBe(true);
  });

  it('a sign-contradiction trigger (preAnswer nulled) is required: true', () => {
    const iv = buildInterview(
      [
        { accountCode: '7900', accountName: 'Unrealised exchange loss', cyBalance: 300, pyBalance: null },
        { accountCode: '7901', accountName: 'Unrealised exchange gain', cyBalance: -500, pyBalance: null },
      ],
      { hasPriorReturn: false }
    );
    const fx = iv.questions.find((q) => q.id === 'unrealizedFxAddBack');
    expect(fx!.preAnswer).toBeNull();
    expect(fx!.required).toBe(true);
  });

  it('dividendsExemptPE is always required: true, even with a clean netted pre-answer', () => {
    const iv = buildInterview(
      [{ accountCode: '4900', accountName: 'Dividend income', cyBalance: -10000, pyBalance: null }],
      { hasPriorReturn: false }
    );
    const div = iv.questions.find((q) => q.id === 'dividendsExemptPE');
    expect(div).toBeDefined();
    // eligibility amount is netted cleanly...
    expect(div!.preAnswer).toBe(10000);
    // ...but the participation-exemption anti-abuse test is a legal judgment
    // call that must never be silently auto-accepted.
    expect(div!.required).toBe(true);
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
    // anchored since the YA2025 survey (p3!E8, field 2a)
    expect(fills[0].anchorId).toBe('depreciationAddBack');
  });

  it('keeps schedule-backed items as manual entries (anchor is a formula cell)', () => {
    const fills = fillsFromAnswers({ capitalAllowancesTotal: 5000, dividendsExemptPE: 800 });
    expect(fills).toHaveLength(2);
    for (const f of fills) expect(f.anchorId).toBeNull();
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

  it('triggers generalProvisionsAddBack on a P&L provision/impairment movement line', () => {
    const iv = buildInterview(
      [{ accountCode: '8200', accountName: 'Provision for doubtful debts', cyBalance: 1500, pyBalance: null }],
      { hasPriorReturn: false }
    );
    const gp = iv.questions.find((q) => q.id === 'generalProvisionsAddBack');
    expect(gp).toBeDefined();
    expect(gp!.preAnswer).toBe(1500);
    expect(gp!.legalBasis).toMatch(/Cap\. 123 Art\. 14\(1\)\(d\)/);
  });

  it('does not trigger generalProvisionsAddBack on a balance-sheet cumulative provision', () => {
    const iv = buildInterview(
      [
        { accountCode: '0032', accountName: 'Accumulated provision for depreciation', cyBalance: -12000, pyBalance: null },
      ],
      { hasPriorReturn: false }
    );
    expect(iv.questions.some((q) => q.id === 'generalProvisionsAddBack')).toBe(false);
  });

  it('always asks the IPA/FIA split questions, blank and required, regardless of the ETB', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    const ipa = iv.questions.find((q) => q.id === 'propertyIncomeIPA');
    const fia = iv.questions.find((q) => q.id === 'foreignSourceIncomeFIA');
    expect(ipa).toBeDefined();
    expect(fia).toBeDefined();
    expect(ipa!.preAnswer).toBeNull();
    expect(fia!.preAnswer).toBeNull();
    expect(ipa!.required).toBe(true);
    expect(fia!.required).toBe(true);
  });

  it('always asks the refund-category and NID questions, blank; refund flags + nidClaimed required, NID amounts not', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    // The refund yes/no flags and the NID claimed gate are genuine legal
    // judgment calls (like dividendsExemptPE) — forced every time.
    for (const id of ['refundDtrClaimed', 'refundPassiveIncome', 'refundParticipatingHolding100', 'nidClaimed']) {
      const q = iv.questions.find((x) => x.id === id);
      expect(q, id).toBeDefined();
      expect(q!.preAnswer, id).toBeNull();
      expect(q!.required, id).toBe(true);
    }
    // nidReferenceRate/nidRiskCapital are pure manual figures with no ETB
    // grounding, meaningful only when nidClaimed=yes — not forced on every
    // return (a return with no NID claim would otherwise be blocked by two
    // irrelevant blank number fields).
    for (const id of ['nidReferenceRate', 'nidRiskCapital']) {
      const q = iv.questions.find((x) => x.id === id);
      expect(q, id).toBeDefined();
      expect(q!.preAnswer, id).toBeNull();
      expect(q!.required, id).toBe(false);
    }
    expect(iv.questions.find((q) => q.id === 'refundDtrClaimed')!.kind).toBe('yesno');
    expect(iv.questions.find((q) => q.id === 'nidClaimed')!.kind).toBe('yesno');
    expect(iv.questions.find((q) => q.id === 'nidReferenceRate')!.kind).toBe('amount');
  });

  it('fillsFromAnswers routes IPA/FIA amounts to manual-entry fills but skips refund/NID sidecar ids', () => {
    const fills = fillsFromAnswers({
      propertyIncomeIPA: 10000,
      foreignSourceIncomeFIA: 5000,
      refundDtrClaimed: 1,
      refundPassiveIncome: 0,
      refundParticipatingHolding100: 0,
      nidClaimed: 1,
      nidReferenceRate: 0.0919,
      nidRiskCapital: 100000,
    });
    expect(fills).toHaveLength(2);
    for (const f of fills) expect(f.anchorId).toBeNull();
    expect(fills.map((f) => f.amount).sort((a, b) => a - b)).toEqual([5000, 10000]);
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
