/**
 * Anchors into the CfR template beyond the B_Sheet/Income code rows.
 * Surveyed against the TA2_e-CO_2025_Ver 1.1 template (YA2025) and verified
 * identical across three independently filed YA2025 returns. An anchor that is
 * null means "cannot be written directly": the target field is a formula fed
 * by a TRA schedule, so the item is shown on the computation summary as a
 * MANUAL ENTRY reminder instead — writing the cell would overwrite the
 * template's own computation.
 */
export interface DirectAnchor {
  sheet: string;
  ref: string;
  /** Description cell of a "[Please specify below]" row — the fill's label is written here. */
  labelRef?: string;
  /** The template ADDS this field into its subtotal (e.g. 67a = 65a + 66a), so a deduction must be written negative. */
  negate?: boolean;
}

export const ANCHORS: Record<string, DirectAnchor | null> = {
  netProfitPerAccounts: { sheet: 'p3', ref: 'E6' }, // field 1a
  // Field 66b (Maltese Taxed A/c column of "Unabsorbed Trading Losses b/fwd").
  // ponytail: standard local trading company assumed — all income sits in the
  // Maltese Taxed Account; add Immovable Property (66a/K52) and Foreign Income
  // (66c/R52) columns when a non-MTA profile is supported.
  lossesBroughtForward: { sheet: 'p4', ref: 'O52', negate: true },
  capitalAllowancesTotal: null, // fields 43a–c are formulas from the TRA5 schedule — enter per-asset on TRA5
  depreciationAddBack: { sheet: 'p3', ref: 'E8' }, // field 2a
  finesPenaltiesAddBack: { sheet: 'p3', ref: 'E33', labelRef: 'B33' }, // field 14a (disallowed expenditure, specify)
  donationsAddBack: { sheet: 'p3', ref: 'E41', labelRef: 'B41' }, // field 16a (other add-backs, specify)
  entertainmentAddBack: { sheet: 'p3', ref: 'E42', labelRef: 'B42' }, // field 17a (other add-backs, specify)
  unrealizedFxAddBack: { sheet: 'p3', ref: 'E20', labelRef: 'B20' }, // field 7a (unrealised losses, specify)
  dividendsExemptPE: null, // field 31a is a formula from the TRA8 schedule — enter on TRA8
};
