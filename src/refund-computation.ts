/**
 * Shareholder refund working — a preparer's reference computation of the
 * ITMA (Cap. 372) Art. 48(4)/(4A) refund a shareholder may claim after a
 * dividend distribution out of the Maltese Taxed Account (MTA) or Foreign
 * Income Account (FIA). Pure arithmetic, no AI. NOT written to the CfR
 * return: the refund is a shareholder-level claim filed separately (via
 * form DDT10, outside this app), never a company tax-return figure, so this
 * module only ever produces a working paper for the preparer to review
 * before advising the shareholder and filing the claim.
 *
 * ponytail: refunds never attach to Final Tax Account, Immovable Property
 * Account or Untaxed Account distributions (Art. 48(4) proviso) — this
 * module assumes the preparer has already confirmed the distribution comes
 * out of MTA/FIA before calling it; it does not itself inspect the p3 row
 * 99 tax-account split.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

export type RefundCategory =
  | 'standard'
  | 'passiveInterestRoyalties'
  | 'dtrClaimed'
  | 'participatingHolding100';

/** ITMA (Cap. 372) Art. 48(4)/(4A) fractions, keyed by the fact pattern that applies. */
const FRACTIONS: Record<RefundCategory, number> = {
  standard: 6 / 7,
  passiveInterestRoyalties: 5 / 7,
  dtrClaimed: 2 / 3,
  participatingHolding100: 1,
};

const CATEGORY_LABEL: Record<RefundCategory, string> = {
  standard: 'Standard refund (6/7)',
  passiveInterestRoyalties: 'Passive interest/royalties (5/7)',
  dtrClaimed: 'Double-tax relief claimed on FIA profits (2/3)',
  participatingHolding100: 'Participating holding taxed, exemption not claimed (100%)',
};

export interface RefundComputation {
  category: RefundCategory;
  /** 6/7, 5/7, 2/3, or 1. */
  fraction: number;
  /** The MTA/FIA tax this refund attaches to (this working uses the company's tax charge as the base). */
  taxPaid: number;
  refundAmount: number;
  notes: string[];
}

/**
 * `taxPaid` is the Malta tax paid on the distribution the shareholder is
 * claiming against — this app passes the company's tax charge as a
 * standard-case base; a preparer handling a partial distribution should
 * substitute the actual amount before relying on this working.
 */
export function computeRefund(taxPaid: number, category: RefundCategory): RefundComputation {
  const fraction = FRACTIONS[category];
  const refundAmount = round2(taxPaid * fraction);
  const notes = [
    `${CATEGORY_LABEL[category]} — ITMA (Cap. 372) Art. 48(4)/(4A).`,
    'Refund preconditions (NOT computable facts — the preparer must confirm each one applies before filing): ' +
      '(1) the shareholder is registered for tax refund purposes; ' +
      '(2) a dividend certificate under Art. 59(5) has been issued to the shareholder; ' +
      "(3) the company's own tax return for the relevant year has been filed; " +
      '(4) the underlying tax has actually been paid.',
    'Claim window: the refund claim must be made within 4 years from the end of the year in which the dividend was distributed.',
    'Refunds attach only to distributions out of the Maltese Taxed Account (MTA) or Foreign Income Account (FIA) — never the Final Tax Account (FTA), Immovable Property Account (IPA), or Untaxed Account (UA).',
  ];
  return { category, fraction, taxPaid, refundAmount, notes };
}
