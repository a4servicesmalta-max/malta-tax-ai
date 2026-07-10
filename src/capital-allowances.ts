/**
 * Malta statutory wear-and-tear (capital allowance) rates, from the Deduction for
 * Wear and Tear of Plant and Machinery Rules (S.L. 123.01) under the Income Tax Act
 * (Cap. 123), as published by the CfR. Rates verified 2026-07 against PwC's Malta
 * corporate tax summary (taxsummaries.pwc.com/malta/corporate/deductions).
 *
 * This is GUIDANCE ONLY: it tells the preparer the statutory minimum write-off
 * period / annual rate for each asset category they hold, so the capital-
 * allowances figure they enter is grounded in the law. It NEVER computes the
 * figure itself — the tax base is the asset cost from the fixed-asset register /
 * TRA5, which is not in the ETB, so an auto-computed number would be invented.
 */

export interface WearAndTearCategory {
  category: string;
  /** Minimum number of years to write the asset off over (straight line). */
  years: number;
  /** Keyword test on the ledger account name. */
  match: RegExp;
}

/** Ordered most-specific first (first match wins). */
export const WEAR_AND_TEAR: WearAndTearCategory[] = [
  { category: 'Computer software', years: 4, match: /software|licen[cs]e|erp|saas/i },
  { category: 'Computers and electronic equipment', years: 4, match: /computer|laptop|server|electronic|\bit\b|hardware|printer|network/i },
  { category: 'Motor vehicles', years: 5, match: /motor|vehicle|\bcar\b|\bvan\b|truck|lorry|forklift/i },
  { category: 'Air conditioners', years: 6, match: /air.?condition|\bhvac\b|\bac unit/i },
  { category: 'Catering equipment', years: 6, match: /catering|kitchen equip|refriger|\boven\b/i },
  { category: 'Medical equipment', years: 6, match: /medical|dental|surgical|diagnostic/i },
  { category: 'Communications and broadcasting equipment', years: 6, match: /broadcast|communication equip|antenna|transmitter/i },
  { category: 'Equipment for building construction and excavation', years: 6, match: /excavat|construction equip|crane|bulldozer|digger/i },
  { category: 'Water/electricity production equipment', years: 6, match: /generator|solar|photovoltaic|\bpv\b|turbine/i },
  { category: 'Furniture, fixtures, fittings and soft furnishings', years: 10, match: /furnitur|fixture|fitting|furnishing|\bff&e\b/i },
  { category: 'Lifts and escalators', years: 10, match: /lift|elevator|escalator/i },
  { category: 'Ships and vessels', years: 10, match: /ship|vessel|\bboat\b|yacht/i },
  { category: 'Electrical and plumbing installations; sanitary fittings', years: 15, match: /electrical install|plumbing|sanitary/i },
  // Generic catch-all last, split per the statutory table: "other machinery" is
  // 5 yrs/20%, "other plant" a separate, slower 10 yrs/10% category — an
  // unclassified "plant"/generic-equipment name defaults to the slower, more
  // conservative rate rather than being folded into "machinery".
  { category: 'Other machinery', years: 5, match: /machiner/i },
  { category: 'Other plant', years: 10, match: /plant|equipment|tools|apparatus/i },
];

/** The statutory straight-line rate implied by the minimum write-off period. */
export function annualRate(years: number): number {
  return Math.round((100 / years) * 10) / 10;
}

/** Classify a ledger account name into its wear-and-tear category, or null. */
export function classifyAsset(name: string): WearAndTearCategory | null {
  return WEAR_AND_TEAR.find((c) => c.match.test(name)) ?? null;
}

/**
 * Build capital-allowances guidance for the asset categories actually present in
 * the ETB — one plain-English line per distinct category with its statutory rate,
 * plus the industrial-buildings allowance. Empty array when no assets are found.
 */
export function wearAndTearGuidance(accountNames: string[]): string[] {
  const seen = new Map<string, WearAndTearCategory>();
  let hasBuildings = false;
  for (const raw of accountNames) {
    const n = raw || '';
    // Only look at asset / depreciation lines, not every account.
    if (!/asset|deprecia|cost|\bnbv\b|written down|plant|machiner|equip|vehicle|motor|computer|furnitur|fixture|building|premises|property/i.test(n)) {
      continue;
    }
    if (/industrial building|building|premises|factory|warehouse/i.test(n)) hasBuildings = true;
    const cat = classifyAsset(n);
    if (cat && !seen.has(cat.category)) seen.set(cat.category, cat);
  }
  const lines = [...seen.values()]
    .sort((a, b) => a.years - b.years)
    .map((c) => {
      const line = `${c.category}: minimum ${c.years} years (${annualRate(c.years)}% p.a. straight-line).`;
      return c.category === 'Motor vehicles'
        ? line + ' Non-commercial motor cars: allowance base capped at €14,000 cost; lease deductions restricted proportionately.'
        : line;
    });
  if (hasBuildings) {
    lines.push(
      'Industrial buildings & structures: max 2% per annum, plus a 10% initial allowance in the year the building is first used for the qualifying purpose (factories, warehouses, hotels, car parks, and office business centres over 2,500 sqm first used after 1 Jan 2016 all qualify; ordinary offices/retail generally do not).'
    );
  }
  return lines;
}
