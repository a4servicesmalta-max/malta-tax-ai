/**
 * Anchors into the CfR template beyond the B_Sheet/Income code rows.
 * Populated by running `npm run survey -- <path-to-real-template>` against the
 * firm's current-year template and recording what it reports. An anchor that is
 * null means "not yet surveyed": interview answers targeting it are collected,
 * shown on the computation summary as MANUAL ENTRY items, and never guessed.
 */
export interface DirectAnchor {
  sheet: string;
  ref: string;
}

export const ANCHORS: Record<string, DirectAnchor | null> = {
  netProfitPerAccounts: { sheet: 'p3', ref: 'E6' }, // known from the ported branch
  lossesBroughtForward: null,
  capitalAllowancesTotal: null,
  depreciationAddBack: null,
  finesPenaltiesAddBack: null,
  donationsAddBack: null,
  entertainmentAddBack: null,
  unrealizedFxAddBack: null,
  dividendsExemptPE: null,
};
