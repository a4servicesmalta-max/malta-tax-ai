/**
 * Tax-data interview: structured, conditional questions grounded in the Income
 * Tax Act (Cap. 123). Pre-answers are deterministic (ETB balances, prior-return
 * values) — never AI-invented. The preparer confirms/edits every answer; only
 * confirmed answers produce figures.
 */
import type { EtbAccount, InterviewFill } from './domain';
import { ANCHORS } from './template-map';

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
}

export interface Interview {
  questions: Question[];
}

interface Trigger {
  id: string;
  nameRe: RegExp;
  /** Extra per-trigger exclusion (on top of the global balance-sheet exclusion). */
  excludeRe?: RegExp;
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
    legalBasis: 'Cap. 123 Art. 12(1)(u) — participation exemption for qualifying holdings.',
    expectedSign: 'cr',
  },
];

export interface InterviewContext {
  hasPriorReturn: boolean;
  /** Deterministic pre-answer for losses b/f if extracted from an anchored prior return. */
  priorLossesBroughtForward?: number | null;
}

export function buildInterview(etb: EtbAccount[], ctx: InterviewContext): Interview {
  const questions: Question[] = [];
  for (const t of TRIGGERS) {
    const hits = etb.filter(
      (a) =>
        t.nameRe.test(a.accountName) &&
        !GLOBAL_EXCLUDE_RE.test(a.accountName) &&
        !(t.excludeRe && t.excludeRe.test(a.accountName))
    );
    if (hits.length === 0) continue;
    const net = Math.round(hits.reduce((acc, a) => acc + a.cyBalance, 0) * 100) / 100;
    const signOk = t.expectedSign === 'dr' ? net > 0 : net < 0;
    questions.push({
      id: t.id,
      text: t.text,
      legalBasis: t.legalBasis,
      kind: 'amount',
      preAnswer: signOk ? Math.abs(net) : null,
      triggeredBy: hits.map((a) => `${a.accountCode} ${a.accountName}`),
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
  });
  questions.push({
    id: 'capitalAllowancesTotal',
    text: 'Total capital allowances claimed for the year (per the capital allowances computation / TRA5).',
    legalBasis: 'Cap. 123 Art. 14(1)(f)(j) & Wear and Tear Rules — statutory allowances on plant, machinery and industrial buildings.',
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
  });
  return { questions };
}

const LABELS: Record<string, string> = {
  depreciationAddBack: 'Add back: depreciation/amortisation',
  finesPenaltiesAddBack: 'Add back: fines and penalties',
  donationsAddBack: 'Add back: donations/sponsorships',
  entertainmentAddBack: 'Add back: entertainment',
  unrealizedFxAddBack: 'Adjust: unrealised exchange differences',
  dividendsExemptPE: 'Exempt: participation exemption dividends',
  lossesBroughtForward: 'Deduct: losses brought forward',
  capitalAllowancesTotal: 'Deduct: capital allowances',
};

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
    if (amount === 0) continue;
    const anchor = ANCHORS[id] ?? null;
    fills.push({ anchorId: anchor ? id : null, amount, label: LABELS[id] });
  }
  return fills;
}
