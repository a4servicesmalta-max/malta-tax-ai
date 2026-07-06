/**
 * Deterministic income-tax computation — the preparer's working paper, built
 * from the mapped net profit and the confirmed interview answers BEFORE the
 * return is filled. Pure arithmetic, no AI. The CfR template remains the
 * authoritative computation; this is the standard practice working that the
 * preparer reviews first and files alongside the return.
 *
 * ponytail: standard trading company at the 35% flat rate. Refunds (6/7 etc.),
 * NID, multi-tax-account allocation and the unabsorbed-capital-allowance vs
 * trade-loss carry-forward split are NOT modelled here — the template computes
 * those; extend when non-standard profiles are supported.
 */
import { LABELS } from './interview';

const ADD_BACK_IDS = [
  'depreciationAddBack',
  'finesPenaltiesAddBack',
  'donationsAddBack',
  'entertainmentAddBack',
  'unrealizedFxAddBack',
] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface TaxComputationLine {
  id: string;
  label: string;
  amount: number;
}

export interface TaxComputation {
  netProfitPerAccounts: number;
  addBacks: TaxComputationLine[];
  totalAddBacks: number;
  deductions: TaxComputationLine[];
  totalDeductions: number;
  /** Net profit + add-backs − deductions, before capital allowances and losses. */
  adjustedProfit: number;
  capitalAllowances: number;
  incomeAfterCapitalAllowances: number;
  lossesBroughtForward: number;
  lossesUtilised: number;
  lossesCarriedForward: number;
  chargeableIncome: number;
  /** 35% of chargeable income (Cap. 123 Art. 56(6)). */
  taxCharge: number;
  notes: string[];
}

export function computeTax(
  netProfitPerAccounts: number,
  answers: Record<string, number>
): TaxComputation {
  for (const [id, v] of Object.entries(answers)) {
    if (!(id in LABELS)) throw new Error(`Unknown interview answer id "${id}".`);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`Invalid amount for interview answer "${id}".`);
    }
  }
  const line = (id: string): TaxComputationLine => ({ id, label: LABELS[id], amount: answers[id] ?? 0 });

  const addBacks = ADD_BACK_IDS.map(line).filter((l) => l.amount !== 0);
  const totalAddBacks = round2(addBacks.reduce((a, l) => a + l.amount, 0));
  const deductions = [line('dividendsExemptPE')].filter((l) => l.amount !== 0);
  const totalDeductions = round2(deductions.reduce((a, l) => a + l.amount, 0));

  const adjustedProfit = round2(netProfitPerAccounts + totalAddBacks - totalDeductions);
  // Current-year allowances plus unabsorbed allowances b/f (Art. 14(1)(f)
  // proviso) — both reduce income before loss relief.
  const capitalAllowances = round2(
    (answers['capitalAllowancesTotal'] ?? 0) + (answers['unabsorbedCapitalAllowancesBf'] ?? 0)
  );
  const incomeAfterCapitalAllowances = round2(adjustedProfit - capitalAllowances);

  const lossesBroughtForward = answers['lossesBroughtForward'] ?? 0;
  const lossesUtilised = round2(Math.min(lossesBroughtForward, Math.max(incomeAfterCapitalAllowances, 0)));
  const lossesCarriedForward = round2(lossesBroughtForward - lossesUtilised);

  const chargeableIncome = round2(Math.max(incomeAfterCapitalAllowances - lossesUtilised, 0));
  const taxCharge = round2(chargeableIncome * 0.35);

  const notes: string[] = [];
  if (incomeAfterCapitalAllowances < 0) {
    notes.push(
      `Current-year loss of €${(-incomeAfterCapitalAllowances).toFixed(2)} — available for carry-forward subject to Cap. 123 Art. 14(1)(g) (trade losses) / unabsorbed capital allowance rules.`
    );
  }
  if (lossesCarriedForward > 0) {
    notes.push(`Unabsorbed losses carried forward: €${lossesCarriedForward.toFixed(2)}.`);
  }

  return {
    netProfitPerAccounts,
    addBacks,
    totalAddBacks,
    deductions,
    totalDeductions,
    adjustedProfit,
    capitalAllowances,
    incomeAfterCapitalAllowances,
    lossesBroughtForward,
    lossesUtilised,
    lossesCarriedForward,
    chargeableIncome,
    taxCharge,
    notes,
  };
}
