/** Standalone domain types. Adapted from maltaCit.domain.ts (no engagement/Prisma). */

export type CfrSheet = 'B_Sheet' | 'Income';

/** One normalized ETB line parsed from the raw client Excel. Dr +, Cr −. */
export interface EtbAccount {
  accountCode: string;
  accountName: string;
  /** Current-year adjusted/final balance — feeds the return. */
  cyBalance: number;
  /** Prior-year comparative balance (used for the prior-return cross-check). */
  pyBalance: number | null;
  /**
   * Statement routing from the ETB itself (audit-file "Profit & Loss"/"Balance
   * Sheet" split columns, or a P/B flag column). Authoritative when present:
   * a PL account may only map to Income codes, a BS account only to B_Sheet.
   */
  statement?: 'PL' | 'BS' | null;
}

export interface MappingRule {
  ledgerCode?: string;
  ledgerNameMatch?: string;
  cfrCode: number;
  sheet: CfrSheet;
}

export interface MappingProfile {
  rules: MappingRule[];
}

export interface ProposedRule {
  ledgerCode: string;
  cfrCode: number;
  sheet: CfrSheet;
  confidence: number;
}

/** An interview answer that lands on the return as a deterministic figure. */
export interface InterviewFill {
  /** Anchor id resolved via template-map, or null = manual entry (listed in summary). */
  anchorId: string | null;
  amount: number;
  label: string;
}
