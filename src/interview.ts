/**
 * Tax-data interview: structured, conditional questions grounded in the Income
 * Tax Act (Cap. 123). Pre-answers are deterministic (ETB balances, prior-return
 * values) — never AI-invented. The preparer confirms/edits every answer; only
 * confirmed answers produce figures.
 */
import type { EtbAccount, InterviewFill } from './domain';
import { ANCHORS } from './template-map';
import { wearAndTearGuidance } from './capital-allowances';

export interface Question {
  id: string;
  text: string;
  /** Statutory grounding shown to the preparer. */
  legalBasis: string;
  kind: 'amount' | 'yesno';
  /** Deterministic pre-answer (ETB-derived) or null = preparer must supply. */
  preAnswer: number | null;
  /** Which ETB accounts triggered this question, as "<code> <name>" (provenance shown to the preparer). */
  triggeredBy: string[];
  /**
   * True when this question genuinely requires a human decision, false when a
   * deterministic figure already exists and the preparer only needs to
   * glance and confirm. Computed as `preAnswer === null`, EXCEPT
   * `dividendsExemptPE`, which is always `true` — the participation-exemption
   * anti-abuse test is a legal judgment call even when a netted amount can be
   * pre-filled from the ETB, so it must never be silently auto-accepted.
   */
  required: boolean;
}

export interface Interview {
  questions: Question[];
}

interface Trigger {
  id: string;
  nameRe: RegExp;
  /** Extra per-trigger exclusion (on top of the global balance-sheet exclusion). */
  excludeRe?: RegExp;
  /** Bypass GLOBAL_EXCLUDE_RE for this trigger (it supplies its own balance-sheet exclusion via excludeRe). */
  skipGlobalExclude?: boolean;
  text: string;
  legalBasis: string;
  /**
   * Sign the netted hits must carry for a deterministic pre-answer:
   * 'dr' = expense add-backs (net > 0), 'cr' = income items (net < 0).
   * A net on the wrong side (mixed/contradictory hits) yields preAnswer = null
   * — manual entry is the safe default, never a fabricated figure.
   */
  expectedSign: 'dr' | 'cr';
}

/**
 * Balance-sheet lookalikes excluded from ALL amount triggers: accumulated
 * depreciation and provisions are cumulative positions, not P&L charges.
 */
const GLOBAL_EXCLUDE_RE = /accumulat|provision/i;

const TRIGGERS: Trigger[] = [
  {
    id: 'depreciationAddBack',
    nameRe: /deprecia|amortis|amortiz/i,
    text: 'Depreciation/amortisation charged in the accounts is not deductible; it is added back and capital allowances are claimed instead. Confirm the add-back amount.',
    legalBasis: 'Cap. 123 Art. 14(1)(f) & Deduction (Wear and Tear) Rules — book depreciation replaced by statutory capital allowances.',
    expectedSign: 'dr',
  },
  {
    id: 'finesPenaltiesAddBack',
    nameRe: /fine|penalt/i,
    text: 'Fines and penalties are not wholly and exclusively incurred in the production of income. Confirm the add-back amount.',
    legalBasis: 'Cap. 123 Art. 14(1) — deduction limited to outgoings wholly and exclusively incurred in the production of the income.',
    expectedSign: 'dr',
  },
  {
    id: 'donationsAddBack',
    nameRe: /donation|sponsor/i,
    text: 'Donations/sponsorships are generally not deductible unless under an approved scheme. Confirm the non-deductible amount.',
    legalBasis: 'Cap. 123 Art. 14(1) wholly-and-exclusively test; approved-scheme exceptions per subsidiary legislation.',
    expectedSign: 'dr',
  },
  {
    id: 'entertainmentAddBack',
    nameRe: /entertain|hospitality/i,
    text: 'Business entertainment is typically non-deductible in part or whole. Confirm the add-back amount.',
    legalBasis: 'Cap. 123 Art. 14(1) wholly-and-exclusively test as applied to entertainment expenditure.',
    expectedSign: 'dr',
  },
  {
    id: 'unrealizedFxAddBack',
    nameRe: /unrealis|unrealiz|exchange (?:gain|loss|difference)/i,
    text: 'Unrealised exchange differences are not taxable/deductible until realised. Confirm the adjustment amount.',
    legalBasis: 'Cap. 123 Arts. 4 & 14 — income/deductions arise when realised (derived), not on retranslation.',
    expectedSign: 'dr',
  },
  {
    id: 'dividendsExemptPE',
    nameRe: /dividend/i,
    excludeRe: /payable|proposed|declared/i,
    text: 'Dividend income may qualify for the participation exemption. Confirm the exempt amount (0 if not applicable).',
    legalBasis:
      'Cap. 123 Art. 12(1)(u) — participation exemption for qualifying holdings. Dividends also need an anti-abuse condition: EU-resident/incorporated body, or foreign tax ≥15%, or ≤50% passive interest/royalties. Exempt amounts are allocated to the Untaxed Account (since YA 2020).',
    expectedSign: 'cr',
  },
  {
    id: 'generalProvisionsAddBack',
    nameRe: /provision|impairment|expected credit loss|\becl\b/i,
    // Own balance-sheet exclusion (this trigger bypasses GLOBAL_EXCLUDE_RE, which
    // would otherwise blanket-exclude every "provision" hit, including the P&L
    // movement lines this trigger exists to catch).
    excludeRe: /deprecia|accumulat/i,
    skipGlobalExclude: true,
    text: 'Movements in general provisions (bad debts, impairments, ECL) are not deductible — only specific, proven bad debts qualify. Confirm the add-back amount.',
    legalBasis:
      'Cap. 123 Art. 14(1)(d) — bad debts deductible only when proved to have become bad in the basis year; general/collective provisions are not.',
    expectedSign: 'dr',
  },
];

export interface InterviewContext {
  hasPriorReturn: boolean;
  /** Deterministic pre-answer for losses b/f if extracted from an anchored prior return. */
  priorLossesBroughtForward?: number | null;
  /** Deterministic pre-answer for unabsorbed capital allowances b/f from the prior return. */
  priorUnabsorbedCaBf?: number | null;
}

export function buildInterview(etb: EtbAccount[], ctx: InterviewContext): Interview {
  const questions: Question[] = [];
  for (const t of TRIGGERS) {
    const hits = etb.filter(
      (a) =>
        t.nameRe.test(a.accountName) &&
        (t.skipGlobalExclude || !GLOBAL_EXCLUDE_RE.test(a.accountName)) &&
        !(t.excludeRe && t.excludeRe.test(a.accountName))
    );
    if (hits.length === 0) continue;
    const net = Math.round(hits.reduce((acc, a) => acc + a.cyBalance, 0) * 100) / 100;
    const signOk = t.expectedSign === 'dr' ? net > 0 : net < 0;
    const preAnswer = signOk ? Math.abs(net) : null;
    questions.push({
      id: t.id,
      text: t.text,
      legalBasis: t.legalBasis,
      kind: 'amount',
      preAnswer,
      triggeredBy: hits.map((a) => `${a.accountCode} ${a.accountName}`),
      // dividendsExemptPE: the amount can be netted from the ETB, but PE
      // eligibility is a legal judgment — never silently auto-accepted.
      required: t.id === 'dividendsExemptPE' ? true : preAnswer === null,
    });
  }
  // Always asked — continuity items.
  questions.push({
    id: 'lossesBroughtForward',
    text: 'Unabsorbed tax losses brought forward from prior years (0 if none).',
    legalBasis: 'Cap. 123 Art. 14(1)(g) — carry-forward of losses incurred in a trade etc.',
    kind: 'amount',
    preAnswer: ctx.priorLossesBroughtForward ?? null,
    triggeredBy: [],
    required: (ctx.priorLossesBroughtForward ?? null) === null,
  });
  questions.push({
    id: 'unabsorbedCapitalAllowancesBf',
    text: 'Unabsorbed capital allowances brought forward from prior years (0 if none).',
    legalBasis:
      'Cap. 123 Art. 14(1)(f) proviso — unabsorbed wear-and-tear allowances are carried forward and set against income of the same source in subsequent years.',
    kind: 'amount',
    preAnswer: ctx.priorUnabsorbedCaBf ?? null,
    triggeredBy: [],
    required: (ctx.priorUnabsorbedCaBf ?? null) === null,
  });
  const caGuidance = wearAndTearGuidance(etb.map((a) => a.accountName));
  questions.push({
    id: 'capitalAllowancesTotal',
    text: 'Total capital allowances claimed for the year (per the capital allowances computation / TRA5).',
    legalBasis:
      'Cap. 123 Art. 14(1)(f)(j) & Deduction (Wear and Tear) Rules S.L. 123.01 — statutory allowances on plant, machinery and industrial buildings.' +
      (caGuidance.length
        ? ' Statutory write-off periods for the asset categories in this ETB — ' + caGuidance.join(' ')
        : ''),
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  // IPA/FIA split of adjusted profit (p3 row 99, fields 37a/37c). The amount
  // CAN be netted from the ETB in principle, but classifying income as
  // Malta-immovable-property or foreign-source is a legal judgment (like
  // dividendsExemptPE above) — no trigger-based pre-answer, always asked,
  // always required so the split is never silently defaulted to "all MTA".
  questions.push({
    id: 'propertyIncomeIPA',
    text: 'Amount of the adjusted profit that is Malta immovable-property income (rental profit, property dealing) to be allocated to the Immovable Property Account. Confirm 0 if none.',
    legalBasis:
      'Cap. 123 — profit from immovable property situated in Malta is allocated to the Immovable Property Account (IPA) rather than the Maltese Taxed Account; the p3 row 99 (fields 37a–c) split is a legal classification, not an ETB-derivable figure.',
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  questions.push({
    id: 'foreignSourceIncomeFIA',
    text: 'Amount of the adjusted profit that is foreign-source income (interest, royalties, or other income not Malta-sourced) to be allocated to the Foreign Income Account. Confirm 0 if none.',
    legalBasis:
      'Cap. 123 — foreign-source income not exempted under the participation exemption is allocated to the Foreign Income Account (FIA); classifying "foreign vs Malta source" from ETB account names alone is not reliable enough to auto-fill silently.',
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  // Shareholder refund category flags (ITMA Cap. 372 Art. 48(4)/(4A)) — a
  // preparer's working only, never anchored to the return (see
  // refund-computation.ts). Priority order applied in server.ts: DTR claimed
  // > passive interest/royalties > participating holding taxed > standard.
  questions.push({
    id: 'refundDtrClaimed',
    text: 'Was double-tax relief (DTR) claimed on the FIA profits being distributed?',
    legalBasis:
      'ITMA (Cap. 372) Art. 48(4)/(4A) — a 2/3 shareholder refund applies whenever any double-tax relief was claimed on the FIA profits underlying the distribution, taking priority over the passive-income 5/7 rate.',
    kind: 'yesno',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  questions.push({
    id: 'refundPassiveIncome',
    text: 'Is this a distribution of passive interest or royalties (foreign tax suffered under 5%, not trade-derived)?',
    legalBasis:
      'ITMA (Cap. 372) Art. 48(4)(a) — passive interest/royalties suffering foreign tax below 5% and not trade-derived attract a 5/7 refund instead of the standard 6/7.',
    kind: 'yesno',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  questions.push({
    id: 'refundParticipatingHolding100',
    text: 'Is this a distribution of participating-holding profits where the company elected to TAX them (not claim the participation exemption)?',
    legalBasis:
      'Cap. 123 Art. 12(1)(u) / ITMA Art. 48(4A) — a company may elect to tax participating-holding profits instead of claiming the participation exemption, in which case a 100% shareholder refund applies on distribution.',
    kind: 'yesno',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  // Notional Interest Deduction (S.L. 123.176) working inputs — computed but
  // never anchored into the return's TRA100 schedule (see nid-computation.ts).
  questions.push({
    id: 'nidClaimed',
    text: 'Is a Notional Interest Deduction (NID) being claimed for this year?',
    legalBasis:
      'S.L. 123.176 (Notional Interest Deduction Rules) — requires the approval of ALL shareholders of the company for the year of claim, which is not a computable fact.',
    kind: 'yesno',
    preAnswer: null,
    triggeredBy: [],
    required: true,
  });
  questions.push({
    id: 'nidReferenceRate',
    text: 'NID reference rate for the year (e.g. 0.0919 for 9.19%), as published by the Central Bank of Malta. Confirm 0 if NID is not being claimed this year.',
    legalBasis:
      'S.L. 123.176 rule 3 — the reference rate (risk-free government bond yield plus a premium, minimum 5%) is published annually and changes every year; it must never be hardcoded.',
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
    // Unlike propertyIncomeIPA/foreignSourceIncomeFIA/dividendsExemptPE, this
    // is not a judgment call netted from real ETB activity — it's a pure
    // manual figure meaningful only when nidClaimed=yes (gated separately, and
    // itself required). Forcing it on every return would block the common
    // case (no NID claim) for a field with no bearing on the outcome.
    required: false,
  });
  questions.push({
    id: 'nidRiskCapital',
    text: 'Risk capital for the NID computation (balance-sheet equity per S.L. 123.176 rule 4, adjusted per the Rules). Confirm 0 if NID is not being claimed this year.',
    legalBasis:
      'S.L. 123.176 rule 4 — risk capital is derived from the balance sheet (share capital, share premium, positive retained earnings, interest-free loans, etc.); not reliably inferable from the ETB mapping in this app version.',
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
    // See nidReferenceRate above — same reasoning.
    required: false,
  });
  // p2 statutory questionnaire answers written onto the return itself (see
  // firm-defaults.ts declarationCells) — the CfR e-return marks them Required.
  const payrollHits = etb.filter((a) => /wage|salar|payroll|remunerat/i.test(a.accountName));
  questions.push({
    id: 'avgEmployees',
    text: 'Average number of employees during the year, including office holders (p2 questionnaire — written to the return).',
    legalBasis: 'TA2 p2 statutory questionnaire; drives the FS3/FS7 wages-reported declaration.',
    kind: 'amount',
    // No payroll in the ETB = deterministically 0; payroll present = the
    // headcount is not an ETB-derivable figure, the preparer supplies it.
    preAnswer: payrollHits.length === 0 ? 0 : null,
    triggeredBy: payrollHits.map((a) => `${a.accountCode} ${a.accountName}`),
    required: payrollHits.length > 0,
  });
  questions.push({
    id: 'auditReportQualified',
    text: 'Is the audit report qualified, or does it carry an emphasis-of-matter paragraph? (p2 questionnaire — written to the return; if yes, the description must be typed into p2 cell C78.)',
    legalBasis: 'TA2 p2 statutory questionnaire on the audited financial statements accompanying the return.',
    kind: 'yesno',
    preAnswer: 0,
    triggeredBy: [],
    required: false,
  });
  questions.push({
    id: 'atadStandaloneEntity',
    text: 'Is the company a standalone entity in terms of ATAD Regulation 4(3)(b), or a financial undertaking? (p2 questionnaire — written to the return.)',
    legalBasis: 'S.L. 123.187 (EU Anti-Tax Avoidance Directives Implementation Regulations) Reg. 4(3)(b).',
    kind: 'yesno',
    preAnswer: 0,
    triggeredBy: [],
    required: false,
  });
  return { questions };
}

export const LABELS: Record<string, string> = {
  depreciationAddBack: 'Add back: depreciation/amortisation',
  finesPenaltiesAddBack: 'Add back: fines and penalties',
  donationsAddBack: 'Add back: donations/sponsorships',
  entertainmentAddBack: 'Add back: entertainment',
  unrealizedFxAddBack: 'Adjust: unrealised exchange differences',
  dividendsExemptPE: 'Exempt: participation exemption dividends',
  generalProvisionsAddBack: 'Add back: general provisions/impairments',
  lossesBroughtForward: 'Deduct: losses brought forward',
  capitalAllowancesTotal: 'Deduct: capital allowances',
  unabsorbedCapitalAllowancesBf: 'Deduct: unabsorbed capital allowances b/f',
  propertyIncomeIPA: 'Allocate: Immovable Property Account income',
  foreignSourceIncomeFIA: 'Allocate: Foreign Income Account income',
  refundDtrClaimed: 'Refund working: DTR claimed on FIA profits?',
  refundPassiveIncome: 'Refund working: passive interest/royalties distribution?',
  refundParticipatingHolding100: 'Refund working: participating holding taxed (no exemption)?',
  nidClaimed: 'NID: claimed this year?',
  nidReferenceRate: 'NID: reference rate',
  nidRiskCapital: 'NID: risk capital',
  avgEmployees: 'p2: average number of employees',
  auditReportQualified: 'p2: audit report qualified / emphasis of matter?',
  atadStandaloneEntity: 'p2: ATAD standalone entity / financial undertaking?',
};

/**
 * Ids that never anchor to a return cell and are consumed directly by a
 * dedicated computation (shareholder refund working, NID working — see
 * refund-computation.ts / nid-computation.ts) rather than the generic
 * tax-adjustments funnel. Routing them through fillsFromAnswers would
 * produce a spurious "manual entry" adjustment row on the computation
 * summary (e.g. a yes/no flag rendered as "€1.00"), so they are skipped here
 * — server.ts reads them straight off the confirmed answers instead.
 */
const NON_FILL_IDS = new Set([
  'refundDtrClaimed',
  'refundPassiveIncome',
  'refundParticipatingHolding100',
  'nidClaimed',
  'nidReferenceRate',
  'nidRiskCapital',
  // p2 questionnaire answers — written as declarations (firm-defaults.ts),
  // not tax adjustments.
  'avgEmployees',
  'auditReportQualified',
  'atadStandaloneEntity',
]);

/**
 * Confirmed answers -> deterministic fills. Deliberate zero answers produce
 * nothing; non-finite amounts and unknown question ids throw — silent drops
 * would understate the return.
 */
export function fillsFromAnswers(answers: Record<string, number>): InterviewFill[] {
  const fills: InterviewFill[] = [];
  for (const [id, amount] of Object.entries(answers)) {
    if (!(id in LABELS)) {
      throw new Error(`Unknown interview answer id "${id}".`);
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error(`Invalid amount for interview answer "${id}".`);
    }
    if (NON_FILL_IDS.has(id)) continue;
    if (amount === 0) continue;
    const anchor = ANCHORS[id] ?? null;
    fills.push({ anchorId: anchor ? id : null, amount, label: LABELS[id] });
  }
  return fills;
}
