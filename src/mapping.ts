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
// CfR codes below are the ones real preparers actually populate on filed returns
// (verified against 22 filed returns YA2009–2025, scripts/learn-corpus.ts). Order
// is specific → generic because the first keyword match wins.
const PROPOSALS: Array<{ kw: RegExp; cfrCode: number; sheet: CfrSheet; confidence: number }> = [
  // Guard the broad cash/bank match against debt terms so "Bank loan"/"Bank overdraft"
  // fall through to the loans rule below instead of the cash/bank asset line. (VD-638)
  {
    kw: /^(?!.*\b(?:loan|overdraft|borrow|facility|mortgage)\b).*(?:cash|bank|petty)/i,
    cfrCode: 2150,
    sheet: 'B_Sheet',
    confidence: 0.95,
  },
  { kw: /trade debtor|debtor/i, cfrCode: 2052, sheet: 'B_Sheet', confidence: 0.85 },
  { kw: /receivable/i, cfrCode: 2050, sheet: 'B_Sheet', confidence: 0.8 },
  { kw: /prepay/i, cfrCode: 2200, sheet: 'B_Sheet', confidence: 0.8 },
  { kw: /share premium/i, cfrCode: 3805, sheet: 'B_Sheet', confidence: 0.9 },
  { kw: /share capital/i, cfrCode: 3801, sheet: 'B_Sheet', confidence: 0.96 },
  {
    kw: /retained|accumulated (?:profit|loss|earning)|p ?& ?l reserve|profit (?:and|&) loss reserve/i,
    cfrCode: 3905,
    sheet: 'B_Sheet',
    confidence: 0.9,
  },
  // Amounts due to directors/shareholders/related parties: the single most common
  // balance-sheet payable line in real returns (13/22). Before the generic loan rule.
  {
    kw: /due to (?:director|shareholder|related)|director.?s?[' ]?s? (?:loan|current a\/?c|current account|advance)|shareholder.?s? (?:loan|advance)/i,
    cfrCode: 3300,
    sheet: 'B_Sheet',
    confidence: 0.75,
  },
  { kw: /vat (?:payable|control|liability)/i, cfrCode: 3203, sheet: 'B_Sheet', confidence: 0.75 },
  { kw: /trade creditor/i, cfrCode: 3101, sheet: 'B_Sheet', confidence: 0.85 },
  { kw: /accrual|payable|creditor|accrued/i, cfrCode: 3100, sheet: 'B_Sheet', confidence: 0.8 },
  { kw: /bank loan|overdraft|borrow/i, cfrCode: 3022, sheet: 'B_Sheet', confidence: 0.6 },
  {
    kw: /plant (?:and|&)? ?machinery|machinery/i,
    cfrCode: 1350,
    sheet: 'B_Sheet',
    confidence: 0.7,
  },
  { kw: /intangible|goodwill/i, cfrCode: 1200, sheet: 'B_Sheet', confidence: 0.7 },
  { kw: /investment|intercompany/i, cfrCode: 1500, sheet: 'B_Sheet', confidence: 0.5 },
  // Cost-of-sales BEFORE revenue so "Cost of sales" is not stolen by the 'sales' in the
  // revenue rule (first-match-wins). (VD-638)
  { kw: /cost of (?:sales|goods)|\bcogs\b/i, cfrCode: 5998, sheet: 'Income', confidence: 0.6 },
  { kw: /revenue|sales|turnover|income from/i, cfrCode: 5000, sheet: 'Income', confidence: 0.9 },
  { kw: /audit/i, cfrCode: 6173, sheet: 'Income', confidence: 0.95 },
  { kw: /accountancy|accounting fee|bookkeep/i, cfrCode: 6172, sheet: 'Income', confidence: 0.85 },
  { kw: /professional|legal|consult/i, cfrCode: 6170, sheet: 'Income', confidence: 0.7 },
  { kw: /director.*(?:salar|remunerat|fee)/i, cfrCode: 6025, sheet: 'Income', confidence: 0.8 },
  {
    kw: /wage|salar|payroll|staff cost|employee benefit|pension|social security|\bni\b/i,
    cfrCode: 6020,
    sheet: 'Income',
    confidence: 0.82,
  },
  { kw: /company registration|registry fee|mbr fee|annual return fee/i, cfrCode: 6203, sheet: 'Income', confidence: 0.8 },
  { kw: /bank charge/i, cfrCode: 6345, sheet: 'Income', confidence: 0.85 },
  { kw: /interest|finance cost/i, cfrCode: 6340, sheet: 'Income', confidence: 0.6 },
  { kw: /deprecia|amorti/i, cfrCode: 6430, sheet: 'Income', confidence: 0.7 },
  { kw: /motor|vehicle running/i, cfrCode: 6611, sheet: 'Income', confidence: 0.6 },
  { kw: /telephone|telecom|mobile/i, cfrCode: 6313, sheet: 'Income', confidence: 0.7 },
  {
    kw: /admin|overhead|office|other operating|sundry|general expense/i,
    cfrCode: 6608,
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

/**
 * Section-total rows the firm's filed returns carry as TYPED inputs (verified
 * across the 22-return corpus: 5499 on 13, 2299/3799/3998 on 18-19, 6997 and
 * 7050 on 19). Each is pure arithmetic over the mapped component lines — no
 * judgment, no AI. `lo..hi` are the component code ranges feeding the total.
 */
const SECTION_TOTALS: Array<{ sheet: CfrSheet; code: number; lo: number; hi: number }> = [
  { sheet: 'B_Sheet', code: 2299, lo: 1000, hi: 2298 }, // TOTAL ASSETS
  { sheet: 'B_Sheet', code: 3799, lo: 3000, hi: 3798 }, // TOTAL LIABILITIES
  { sheet: 'B_Sheet', code: 3998, lo: 3800, hi: 3997 }, // TOTAL SHAREHOLDER EQUITY
  { sheet: 'Income', code: 5499, lo: 5000, hi: 5498 }, // TOTAL REVENUE
  { sheet: 'Income', code: 5998, lo: 5500, hi: 5997 }, // COST OF SALES
  { sheet: 'Income', code: 6997, lo: 6000, hi: 6996 }, // TOTAL OPERATING EXPENSES
];

/** `sheet:code` keys of derivable total rows — aggregate calculations (net
 *  profit, tie-check sums) must EXCLUDE these or they double-count. */
export const TOTAL_CODE_KEYS = new Set([
  ...SECTION_TOTALS.map((t) => `${t.sheet}:${t.code}`),
  'Income:7050',
]);

/**
 * Derive typed section totals from the mapped lines. Only totals whose row
 * exists on the template as a NON-FORMULA input (writableTotalKeys) are
 * produced — a template that computes its own total must never be overwritten.
 * 7050 (net result) = −(sum of all Income lines) is included when writable.
 */
export function deriveSectionTotals(
  codeCells: CfrCodeCell[],
  writableTotalKeys: Set<string>
): CfrCodeCell[] {
  const out: CfrCodeCell[] = [];
  const existing = new Set(codeCells.map((c) => `${c.sheet}:${c.cfrCode}`));
  for (const t of SECTION_TOTALS) {
    const key = `${t.sheet}:${t.code}`;
    if (!writableTotalKeys.has(key) || existing.has(key)) continue;
    const sum = codeCells
      .filter((c) => c.sheet === t.sheet && c.cfrCode >= t.lo && c.cfrCode <= t.hi)
      .reduce((a, c) => a + c.amount, 0);
    if (Math.abs(sum) > 0.005) out.push({ sheet: t.sheet, cfrCode: t.code, amount: round2(sum) });
  }
  const npKey = 'Income:7050';
  if (writableTotalKeys.has(npKey) && !existing.has(npKey)) {
    const np = -codeCells.filter((c) => c.sheet === 'Income').reduce((a, c) => a + c.amount, 0);
    if (Math.abs(np) > 0.005) out.push({ sheet: 'Income', cfrCode: 7050, amount: round2(np) });
  }
  return out;
}

export interface ProposalContext {
  /** CfR codes present on the client's prior-year return — small confidence boost. */
  priorYearCodes?: Set<number>;
  /**
   * Filed values per code line on the prior-year return (`sheet:code` -> value).
   * Enables value-fingerprint matching: an ETB account whose PRIOR-year balance
   * equals the value the firm filed on a line last year belongs on that line.
   */
  priorYearValues?: Map<string, number>;
  /**
   * The data-entry code rows that actually exist in the uploaded template.
   * When given, proposals with codes not on the template are DROPPED (the
   * account shows as unmapped for the preparer) — a visibly unmapped row is
   * honest; a write to a non-existent row silently leaves that section of the
   * return empty.
   */
  templateCodes?: import('./template-codes').TemplateCode[];
}

/**
 * Statement-routing veto: when the ETB itself says which statement an account
 * belongs to, a proposal on the other sheet is a categorical error — the
 * source of fake-profit blowups (a 1.2M property landing on an Income line).
 */
export function sheetAllowed(acc: Pick<EtbAccount, 'statement'>, sheet: CfrSheet): boolean {
  if (acc.statement === 'PL') return sheet === 'Income';
  if (acc.statement === 'BS') return sheet === 'B_Sheet';
  return true;
}

/**
 * Prior-year value-fingerprint matching: if an account's PY balance equals (±€1)
 * the value the firm actually filed on exactly ONE line last year — and no other
 * account shares that balance — that account belongs on that line. Deterministic
 * and explainable ("you filed this exact figure there last year"); the strongest
 * signal available for repeat clients. Ambiguous fingerprints are skipped:
 * a wrong-but-confident rule is worse than a gap the preparer fills.
 */
export function fingerprintRules(
  accounts: EtbAccount[],
  priorYearValues: Map<string, number>
): ProposedRule[] {
  const TOL = 1;
  // Ignore near-zero fingerprints — dozens of lines carry 0.
  const usable = [...priorYearValues.entries()].filter(([, v]) => Math.abs(v) > TOL);
  const rules: ProposedRule[] = [];
  const claimedCodes = new Set<string>();
  for (const acc of accounts) {
    if (acc.pyBalance === null || Math.abs(acc.pyBalance) <= TOL) continue;
    const matches = usable.filter(([, v]) => Math.abs(Math.abs(v) - Math.abs(acc.pyBalance as number)) <= TOL);
    if (matches.length !== 1) continue; // none or ambiguous
    const [key] = matches[0];
    if (claimedCodes.has(key)) continue; // two accounts share the balance — ambiguous
    const twin = accounts.find(
      (a) =>
        a !== acc &&
        a.pyBalance !== null &&
        Math.abs(Math.abs(a.pyBalance) - Math.abs(acc.pyBalance as number)) <= TOL
    );
    if (twin) continue;
    const [sheet, codeStr] = key.split(':');
    if (!sheetAllowed(acc, sheet as CfrSheet)) continue; // ETB says other statement
    claimedCodes.add(key);
    rules.push({
      ledgerCode: acc.accountCode,
      cfrCode: Number(codeStr),
      sheet: sheet as CfrSheet,
      confidence: 0.99,
    });
  }
  return rules;
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
      if (m && sheetAllowed(acc, m.sheet)) {
        const boost = ctx.priorYearCodes?.has(m.code) ? 0.03 : 0;
        // exact label match → near-certain; strong overlap → high; scale the rest.
        const conf = m.score >= 0.999 ? 0.98 : 0.6 + m.score * 0.3;
        rules.push({ ledgerCode: acc.accountCode, cfrCode: m.code, sheet: m.sheet, confidence: Math.min(0.99, conf + boost) });
        continue;
      }
    }
    // 2) Fallback: keyword heuristics (constrained to codes that exist).
    const name = (acc.accountName || '').toLowerCase();
    const hit = PROPOSALS.find((p) => p.kw.test(name) && sheetAllowed(acc, p.sheet));
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
