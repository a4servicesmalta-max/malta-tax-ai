/**
 * Notional Interest Deduction (NID) working paper — S.L. 123.176 (Notional
 * Interest Deduction Rules). Pure arithmetic, no AI, computed as a
 * standalone reference for the preparer. The CfR template's own NID sheet
 * (TRA100) is a 165-row wizard with day-count proration and cross-links to
 * 4 other sheets — too complex/risky to write into directly this round, so
 * this module NEVER anchors a figure into the return; the preparer must
 * complete TRA100 by hand using this working as a starting point.
 *
 * ponytail: no day-count proration, no multi-entity risk-capital
 * apportionment — a single reference-rate x risk-capital figure, capped at
 * 90% of chargeable income computed before the NID. Extend only if TRA100
 * itself is ever anchored into the return.
 */
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface NidComputation {
  claimed: boolean;
  /** e.g. 0.0919 for 9.19% — passed in, NEVER hardcoded (the CBM-published rate changes yearly). */
  referenceRate: number;
  riskCapital: number;
  /** referenceRate * riskCapital, before the 90% cap. */
  grossDeduction: number;
  /** 90% of chargeable income computed BEFORE the NID. */
  cap: number;
  /** min(grossDeduction, cap) — the amount actually relieved this year. */
  allowedDeduction: number;
  /** grossDeduction - allowedDeduction, when the gross figure exceeds the cap — carried forward, not lost. */
  carriedForward: number;
  notes: string[];
}

/**
 * `chargeableIncomeBeforeNid` is computeTax's existing `chargeableIncome` —
 * that figure does NOT itself subtract the NID (correct: NID is a separate
 * working layered on top of the core computation, not integrated into it
 * this round).
 */
export function computeNid(
  referenceRate: number,
  riskCapital: number,
  chargeableIncomeBeforeNid: number
): NidComputation {
  const grossDeduction = round2(referenceRate * riskCapital);
  const cap = round2(Math.max(chargeableIncomeBeforeNid, 0) * 0.9);
  const allowedDeduction = round2(Math.min(grossDeduction, cap));
  const carriedForward = round2(Math.max(grossDeduction - allowedDeduction, 0));
  const notes = [
    'S.L. 123.176 (Notional Interest Deduction Rules) — reference rate × risk capital, capped at 90% of chargeable income computed before the NID; any excess over the cap carries forward, it is not lost.',
    'Requires the approval of ALL shareholders of the company for the year of claim — NOT a computable fact; the preparer must confirm this approval exists before claiming.',
    '110% of the profit relieved by the NID is allocated to the Final Tax Account (FTA) — no shareholder refund arises on a subsequent distribution of that portion.',
    ...(carriedForward > 0
      ? [`€${carriedForward.toFixed(2)} of the notional interest exceeds the 90% cap this year and carries forward to future years.`]
      : []),
    "This is a computed WORKING only — the CfR template's own TRA100 NID schedule (day-count proration, cross-linked to 4 other sheets) must be completed manually; no NID figure is auto-anchored into the return.",
  ];
  return { claimed: true, referenceRate, riskCapital, grossDeduction, cap, allowedDeduction, carriedForward, notes };
}
