/**
 * CoA -> CfR-code mapping. Ported from maltaCit.mapping.ts (feat/malta-cit-tax-return),
 * adapted for raw-ETB input: statement routing comes from the confirmed mapping itself.
 * No figure is invented here — amounts come straight from the ETB.
 */
import type {
  EtbAccount,
  MappingProfile,
  MappingRule,
  ProposedRule,
  CfrSheet,
} from './domain';
import type { CfrCodeCell, CfrDirectCell } from './template-writer';

export interface MappedFill {
  codeCells: CfrCodeCell[];
  directCells: CfrDirectCell[];
  unmappedAccounts: Array<{ code: string; name: string; balance: number }>;
  /** ledgerCode -> applied rule (provenance for the computation summary). */
  applied: Map<string, MappingRule>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function matchRule(acc: EtbAccount, rules: MappingRule[]): MappingRule | undefined {
  const byCode = rules.find((r) => r.ledgerCode && r.ledgerCode === acc.accountCode);
  if (byCode) return byCode;
  const name = acc.accountName.toLowerCase();
  return rules.find((r) => r.ledgerNameMatch && name.includes(r.ledgerNameMatch.toLowerCase()));
}

/** Net profit derived from lines mapped to Income (income Cr/−, expenses Dr/+). */
export function netProfitFromMapping(fill: Pick<MappedFill, 'codeCells'>): number {
  const plSum = fill.codeCells
    .filter((c) => c.sheet === 'Income')
    .reduce((acc, c) => acc + c.amount, 0);
  return round2(-plSum);
}

export function applyMapping(accounts: EtbAccount[], profile: MappingProfile): MappedFill {
  const byCode = new Map<number, { sheet: CfrSheet; amount: number }>();
  const unmappedAccounts: MappedFill['unmappedAccounts'] = [];
  const applied = new Map<string, MappingRule>();

  for (const acc of accounts) {
    const rule = matchRule(acc, profile.rules);
    if (!rule) {
      unmappedAccounts.push({ code: acc.accountCode, name: acc.accountName, balance: acc.cyBalance });
      continue;
    }
    applied.set(acc.accountCode, rule);
    const cur = byCode.get(rule.cfrCode);
    if (cur) cur.amount += acc.cyBalance;
    else byCode.set(rule.cfrCode, { sheet: rule.sheet, amount: acc.cyBalance });
  }

  const codeCells: CfrCodeCell[] = [...byCode.entries()].map(([cfrCode, v]) => ({
    sheet: v.sheet,
    cfrCode,
    amount: round2(v.amount),
  }));
  const fillNoDirect = { codeCells };
  const directCells: CfrDirectCell[] = [
    { sheet: 'p3', ref: 'E6', value: netProfitFromMapping(fillNoDirect) },
  ];
  return { codeCells, directCells, unmappedAccounts, applied };
}

// --- Heuristic proposal (stand-in / fallback for the AI proposal; human confirms) ---
// Ported verbatim from
// C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\maltaCit.mapping.ts
// lines 100-161 (includes the VD-638 cash-vs-loan guard and cost-of-sales-before-revenue ordering).
const PROPOSALS: Array<{ kw: RegExp; cfrCode: number; sheet: CfrSheet; confidence: number }> = [
  // Guard the broad cash/bank match against debt terms so "Bank loan"/"Bank overdraft"
  // fall through to the loans rule below instead of the cash/bank asset line. (VD-638)
  {
    kw: /^(?!.*\b(?:loan|overdraft|borrow|facility|mortgage)\b).*(?:cash|bank|petty)/i,
    cfrCode: 2150,
    sheet: 'B_Sheet',
    confidence: 0.95,
  },
  { kw: /receivable|debtor/i, cfrCode: 2100, sheet: 'B_Sheet', confidence: 0.85 },
  { kw: /prepay/i, cfrCode: 2200, sheet: 'B_Sheet', confidence: 0.8 },
  { kw: /share capital/i, cfrCode: 3801, sheet: 'B_Sheet', confidence: 0.96 },
  {
    kw: /retained|accumulated|p ?& ?l reserve|profit (?:and|&) loss reserve/i,
    cfrCode: 3905,
    sheet: 'B_Sheet',
    confidence: 0.9,
  },
  { kw: /accrual/i, cfrCode: 3100, sheet: 'B_Sheet', confidence: 0.8 },
  { kw: /payable|creditor/i, cfrCode: 3150, sheet: 'B_Sheet', confidence: 0.82 },
  {
    kw: /loan|borrow|overdraft|director.?s? loan/i,
    cfrCode: 3500,
    sheet: 'B_Sheet',
    confidence: 0.65,
  },
  { kw: /reserve/i, cfrCode: 3950, sheet: 'B_Sheet', confidence: 0.55 },
  {
    kw: /property|plant|equipment|motor|vehicle|fixed asset|depreciation.*(?:asset|cost)/i,
    cfrCode: 1100,
    sheet: 'B_Sheet',
    confidence: 0.7,
  },
  { kw: /intangible|goodwill/i, cfrCode: 1200, sheet: 'B_Sheet', confidence: 0.8 },
  { kw: /investment|intercompany/i, cfrCode: 1500, sheet: 'B_Sheet', confidence: 0.5 },
  {
    kw: /inventor|stock|work in progress|\bwip\b/i,
    cfrCode: 2100,
    sheet: 'B_Sheet',
    confidence: 0.5,
  },
  // Cost-of-sales BEFORE revenue so "Cost of sales" is not stolen by the 'sales' in the
  // revenue rule (first-match-wins). (VD-638)
  { kw: /cost of|purchase|\bcogs\b/i, cfrCode: 6000, sheet: 'Income', confidence: 0.75 },
  { kw: /revenue|sales|turnover/i, cfrCode: 5000, sheet: 'Income', confidence: 0.92 },
  { kw: /audit/i, cfrCode: 6173, sheet: 'Income', confidence: 0.95 },
  { kw: /professional|legal|consult/i, cfrCode: 6170, sheet: 'Income', confidence: 0.7 },
  {
    kw: /wage|salar|payroll|staff|pension|social security/i,
    cfrCode: 6200,
    sheet: 'Income',
    confidence: 0.82,
  },
  { kw: /deprecia|amorti/i, cfrCode: 6300, sheet: 'Income', confidence: 0.85 },
  { kw: /interest|finance cost/i, cfrCode: 7000, sheet: 'Income', confidence: 0.7 },
  {
    kw: /admin|overhead|office|other operating|sundry/i,
    cfrCode: 6100,
    sheet: 'Income',
    confidence: 0.55,
  },
];

// --- Label-similarity matching (learns from the template's own code labels) ---
// Malta CfR code labels ARE the standard account descriptions ("Wages - Regular"
// = 6021), and firms name their ledger accounts to match. So the account name
// vs code label is the strongest, most defensible signal — deterministic, free,
// and explainable — far better than keyword guessing.
const STOP = new Set(['and', 'the', 'for', 'of', 'to', 'other', 'total', 'net', 'a', 'in', 'on']);
function normLabel(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function labelTokens(s: string): string[] {
  return normLabel(s)
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w));
}
/** 0..1 similarity: exact normalized match = 1; else token overlap (Dice) with a containment boost. */
export function labelSimilarity(accountName: string, codeLabel: string): number {
  const na = normLabel(accountName);
  const nl = normLabel(codeLabel);
  if (!na || !nl) return 0;
  if (na === nl) return 1;
  const ta = labelTokens(accountName);
  const tl = labelTokens(codeLabel);
  if (!ta.length || !tl.length) return 0;
  const setL = new Set(tl);
  const inter = ta.filter((t) => setL.has(t)).length;
  const dice = (2 * inter) / (ta.length + tl.length);
  // Boost when the account name fully contains the code label's words (or vice
  // versa) — "Wages - Regular staff" still clearly means "Wages - Regular".
  const contain = inter === Math.min(ta.length, tl.length) ? 0.15 : 0;
  return Math.min(1, dice + contain);
}

/**
 * Best template code for an account by label similarity. Only returns a hit at
 * or above `min` so weak guesses fall through to keyword/AI rather than
 * confidently mislabelling.
 */
export function bestLabelMatch(
  accountName: string,
  templateCodes: import('./template-codes').TemplateCode[],
  min = 0.5
): { code: number; sheet: CfrSheet; score: number } | null {
  let best: { code: number; sheet: CfrSheet; score: number } | null = null;
  for (const c of templateCodes) {
    if (!c.label) continue;
    const score = labelSimilarity(accountName, c.label);
    if (score >= min && (!best || score > best.score)) best = { code: c.code, sheet: c.sheet, score };
  }
  return best;
}

export interface ProposalContext {
  /** CfR codes present on the client's prior-year return — small confidence boost. */
  priorYearCodes?: Set<number>;
  /**
   * The data-entry code rows that actually exist in the uploaded template.
   * When given, proposals with codes not on the template are DROPPED (the
   * account shows as unmapped for the preparer) — a visibly unmapped row is
   * honest; a write to a non-existent row silently leaves that section of the
   * return empty.
   */
  templateCodes?: import('./template-codes').TemplateCode[];
}

export function proposeMapping(
  accounts: EtbAccount[],
  ctx: ProposalContext = {}
): { rules: ProposedRule[] } {
  const validKeys = ctx.templateCodes
    ? new Set(ctx.templateCodes.map((c) => `${c.sheet}:${c.code}`))
    : null;
  const rules: ProposedRule[] = [];
  for (const acc of accounts) {
    // 1) Strongest signal: the account name matches a template code's LABEL.
    if (ctx.templateCodes?.length) {
      const m = bestLabelMatch(acc.accountName, ctx.templateCodes, 0.5);
      if (m) {
        const boost = ctx.priorYearCodes?.has(m.code) ? 0.03 : 0;
        // exact label match → near-certain; strong overlap → high; scale the rest.
        const conf = m.score >= 0.999 ? 0.98 : 0.6 + m.score * 0.3;
        rules.push({ ledgerCode: acc.accountCode, cfrCode: m.code, sheet: m.sheet, confidence: Math.min(0.99, conf + boost) });
        continue;
      }
    }
    // 2) Fallback: keyword heuristics (constrained to codes that exist).
    const name = (acc.accountName || '').toLowerCase();
    const hit = PROPOSALS.find((p) => p.kw.test(name));
    if (!hit) continue;
    if (validKeys && !validKeys.has(`${hit.sheet}:${hit.cfrCode}`)) continue;
    const boost = ctx.priorYearCodes?.has(hit.cfrCode) ? 0.05 : 0;
    rules.push({
      ledgerCode: acc.accountCode,
      cfrCode: hit.cfrCode,
      sheet: hit.sheet,
      confidence: Math.min(0.99, hit.confidence + boost),
    });
  }
  return { rules };
}
