/**
 * Prior-year filed return intake. Deterministic extraction only:
 *  - which CfR codes the client used last year (mapping bias + review context)
 *  - filed values per code (prior-year cross-check)
 * Continuity balances beyond code rows (losses b/f, TRA5 TWDVs, tax accounts)
 * are pre-answered in the interview ONLY where template-map anchors exist.
 *
 * Convention note: some filed returns carry signed values (Dr+/Cr−, B_Sheet
 * nets to ~0); real CfR returns commonly carry ALL-POSITIVE values (the
 * template computes the totals). We detect which convention the return uses
 * (assets = codes < 3000 vs equity & liabilities = codes >= 3000) and both the
 * review and the cross-check honour it.
 */
import * as XLSX from 'xlsx';
import { readCfrValues, type CfrValue } from './template-reader';
import type { EtbAccount, MappingProfile } from './domain';
import { applyMapping } from './mapping';

const CODE_SHEETS = ['B_Sheet', 'Income'];

export type PriorReturnConvention = 'signed' | 'positive' | 'unknown';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Detect the sign convention of a filed return's B_Sheet values. */
function detectConvention(values: CfrValue[]): { convention: PriorReturnConvention; balanceSheetNet: number } {
  const bs = values.filter((v) => v.sheet === 'B_Sheet' && v.value !== null);
  const balanceSheetNet = round2(bs.reduce((a, v) => a + (v.value as number), 0));
  if (bs.length === 0) return { convention: 'unknown', balanceSheetNet };
  if (Math.abs(balanceSheetNet) <= 1) return { convention: 'signed', balanceSheetNet };
  const assets = bs.filter((v) => v.cfrCode < 3000).reduce((a, v) => a + (v.value as number), 0);
  const eqLiab = bs.filter((v) => v.cfrCode >= 3000).reduce((a, v) => a + (v.value as number), 0);
  if (Math.abs(Math.abs(assets) - Math.abs(eqLiab)) <= 1) return { convention: 'positive', balanceSheetNet };
  return { convention: 'unknown', balanceSheetNet };
}

export interface PriorReturnInfo {
  codes: Set<number>;
  values: CfrValue[];
  convention: PriorReturnConvention;
}

export async function readPriorReturn(buffer: Buffer): Promise<PriorReturnInfo> {
  const values = await readCfrValues(buffer, CODE_SHEETS);
  return {
    codes: new Set(values.map((v) => v.cfrCode)),
    values,
    convention: detectConvention(values).convention,
  };
}

/**
 * Losses carried forward on a filed prior return (p4 fields 70a–c) — becomes
 * this year's losses-b/f pre-answer. The row is located by its label text so
 * template-vintage row drift doesn't break it; the three tax-account value
 * cells sit in fixed columns K/O/R. Returns null when nothing readable —
 * never a guessed figure.
 */
export function priorLossesCarriedForward(buffer: Buffer): number | null {
  return sumP4Row(buffer, /unabsorbed trading losses c\/?fwd/i);
}

/**
 * Unabsorbed capital allowances carried forward on the filed prior return
 * (p4 "Unabsorbed capital allowances c/f", value columns K/O/R) — becomes this
 * year's CA-b/f pre-answer. Cached formula values; |sum| because the template
 * carries allowances negative. Null when nothing readable — never guessed.
 */
export function priorUnabsorbedCapitalAllowancesCf(buffer: Buffer): number | null {
  return sumP4Row(buffer, /unabsorbed capital allowances c\/?f(?:wd)?/i);
}

function sumP4Row(buffer: Buffer, labelRe: RegExp): number | null {
  let ws: XLSX.WorkSheet | undefined;
  try {
    ws = XLSX.read(buffer, { type: 'buffer', sheets: ['p4'] }).Sheets['p4'];
  } catch {
    return null;
  }
  if (!ws || !ws['!ref']) return null;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const label = ws[XLSX.utils.encode_cell({ r, c: 2 })];
    if (!label || !labelRe.test(String(label.v))) continue;
    let sum = 0;
    let found = false;
    for (const c of [10, 14, 17]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') {
        sum += cell.v;
        found = true;
      }
    }
    return found ? round2(Math.abs(sum)) : null;
  }
  return null;
}

/**
 * Prior-year income allocated to the tax accounts (p6 "Income for the year
 * allocated to the different tax accounts"). Surfaced as review context — the
 * FTA/IPA/MTA/UA split drives the shareholders' refund entitlement (6/7, 5/7,
 * 2/3), so the preparer sees what was applied last year. Read-only info.
 */
export function priorTaxAccountAllocations(buffer: Buffer): { total: number; nonZero: number } | null {
  let ws: XLSX.WorkSheet | undefined;
  try {
    ws = XLSX.read(buffer, { type: 'buffer', sheets: ['p6'] }).Sheets['p6'];
  } catch {
    return null;
  }
  if (!ws || !ws['!ref']) return null;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const label = ws[XLSX.utils.encode_cell({ r, c: 1 })];
    if (!label || !/allocated to the different tax accounts/i.test(String(label.v))) continue;
    const vals: number[] = [];
    for (let c = 3; c <= 24; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') vals.push(cell.v);
    }
    if (!vals.length) return null;
    return { total: round2(vals.reduce((a, v) => a + v, 0)), nonZero: vals.filter((v) => Math.abs(v) > 0.5).length };
  }
  return null;
}

export interface CrossCheckMismatch {
  sheet: string;
  cfrCode: number;
  priorReturnValue: number;
  mappedPyValue: number;
}

export interface CrossCheckResult {
  checkedCodes: number;
  mismatches: CrossCheckMismatch[];
  /** ETB accounts skipped because they carry no prior-year balance. */
  excludedAccounts: number;
  /** Per-sheet total drift (|filed| vs |mapped| beyond €1) — catches many-small-roundings drift. */
  aggregateDrift: Array<{ sheet: string; filedTotal: number; mappedTotal: number }>;
}

const TOL = 1;

/**
 * Map the ETB's PRIOR-year balances with the proposed profile; the aggregates
 * should reproduce the prior return's filed values. Mismatches = mapping smells.
 * For 'positive'-convention prior returns magnitudes are compared (the filed
 * return has no signs to compare against).
 */
export async function priorYearCrossCheck(
  priorReturn: Buffer,
  etb: EtbAccount[],
  profile: MappingProfile
): Promise<CrossCheckResult> {
  const prior = await readPriorReturn(priorReturn);
  const positive = prior.convention === 'positive';
  const pyAsCy: EtbAccount[] = etb
    .filter((a) => a.pyBalance !== null)
    .map((a) => ({ ...a, cyBalance: a.pyBalance as number, pyBalance: null }));
  const excludedAccounts = etb.length - pyAsCy.length;
  const mapped = applyMapping(pyAsCy, profile);

  const mismatches: CrossCheckMismatch[] = [];
  let checked = 0;
  for (const cell of mapped.codeCells) {
    const filed = prior.values.find((v) => v.sheet === cell.sheet && v.cfrCode === cell.cfrCode);
    if (!filed || filed.value === null) continue;
    checked++;
    const filedV = positive ? Math.abs(filed.value) : filed.value;
    const mappedV = positive ? Math.abs(cell.amount) : cell.amount;
    if (Math.abs(filedV - mappedV) > TOL) {
      mismatches.push({
        sheet: cell.sheet,
        cfrCode: cell.cfrCode,
        priorReturnValue: filed.value,
        mappedPyValue: cell.amount,
      });
    }
  }

  // Filed codes the mapping never produces must not go silently unchecked.
  for (const filed of prior.values) {
    if (filed.value === null || Math.abs(filed.value) <= TOL) continue;
    const produced = mapped.codeCells.some((c) => c.sheet === filed.sheet && c.cfrCode === filed.cfrCode);
    if (!produced) {
      checked++;
      mismatches.push({
        sheet: filed.sheet,
        cfrCode: filed.cfrCode,
        priorReturnValue: filed.value,
        mappedPyValue: 0,
      });
    }
  }

  // Aggregate check: per-sheet totals must also tie, so 40 × €0.99 of per-code
  // drift (each inside tolerance) is still visible.
  const aggregateDrift: CrossCheckResult['aggregateDrift'] = [];
  const sheets = new Set<string>([
    ...prior.values.filter((v) => v.value !== null).map((v) => v.sheet),
    ...mapped.codeCells.map((c) => c.sheet),
  ]);
  for (const sheet of sheets) {
    const filedTotal = round2(
      prior.values.filter((v) => v.sheet === sheet && v.value !== null).reduce((a, v) => a + (v.value as number), 0)
    );
    const mappedTotal = round2(
      mapped.codeCells.filter((c) => c.sheet === sheet).reduce((a, c) => a + c.amount, 0)
    );
    if (Math.abs(Math.abs(filedTotal) - Math.abs(mappedTotal)) > TOL) {
      aggregateDrift.push({ sheet, filedTotal, mappedTotal });
    }
  }

  return { checkedCodes: checked, mismatches, excludedAccounts, aggregateDrift };
}

export interface PriorReviewFinding {
  severity: 'error' | 'warning';
  message: string;
}

export interface PriorReturnReview {
  findings: PriorReviewFinding[];
  /** Sum of B_Sheet code values (~0 for signed returns, gross for positive returns). */
  balanceSheetNet: number;
  /**
   * −(sum of Income code values) = net profit implied by the filed return.
   * Only meaningful for 'signed'-convention returns; null otherwise. A
   * positive-convention return sums revenue + expenses into a nonsense figure,
   * and per-code-class heuristics could themselves produce a silent wrong
   * number — null forces manual entry, the safe default for this tool.
   */
  impliedNetProfit: number | null;
  /** Detected sign convention of the filed return. */
  convention: PriorReturnConvention;
}

/**
 * Deterministic error review of a filed prior-year return. Run BEFORE any
 * working is based on it; findings must be acknowledged by the preparer.
 */
export async function reviewPriorReturn(buffer: Buffer): Promise<PriorReturnReview> {
  let values: CfrValue[];
  try {
    values = await readCfrValues(buffer, CODE_SHEETS);
  } catch {
    return {
      findings: [
        {
          severity: 'error',
          message: 'No code values could be read from the prior-year return — unsupported or empty template.',
        },
      ],
      balanceSheetNet: 0,
      impliedNetProfit: null,
      convention: 'unknown',
    };
  }
  const findings: PriorReviewFinding[] = [];
  const bs = values.filter((v) => v.sheet === 'B_Sheet' && v.value !== null);
  const inc = values.filter((v) => v.sheet === 'Income' && v.value !== null);
  const { convention, balanceSheetNet } = detectConvention(values);
  const impliedNetProfit =
    convention === 'signed' ? round2(-inc.reduce((a, v) => a + (v.value as number), 0)) : null;
  if (convention === 'unknown' && bs.length > 0) {
    const top = [...bs]
      .sort((a, b) => Math.abs(b.value as number) - Math.abs(a.value as number))
      .slice(0, 3)
      .map((v) => `${v.cfrCode} (€${(v.value as number).toFixed(2)})`)
      .join(', ');
    findings.push({
      severity: 'error',
      message:
        `Prior-year return balance sheet does not balance under the signed (Dr+/Cr−) or all-positive conventions: ` +
        `code values net to €${balanceSheetNet.toFixed(2)}. Largest contributors: ${top}. ` +
        `Review the prior return before relying on it.`,
    });
  }
  if (bs.length === 0 && inc.length === 0) {
    findings.push({
      severity: 'error',
      message: 'No code values could be read from the prior-year return — unsupported or empty template.',
    });
  }
  // Arithmetic tie-out: the filed TOTAL rows are template formulas, but a
  // return that was hand-edited after the last recalc (or had rows typed over)
  // carries stale cached totals — a real "prior return contains errors" case.
  // Compare each computed total against the sum of the section's input rows.
  const totalsChecks: Array<{ code: number; sheet: string; label: string; inputs: (v: CfrValue) => boolean }> = [
    { code: 2299, sheet: 'B_Sheet', label: 'TOTAL ASSETS', inputs: (v) => v.sheet === 'B_Sheet' && v.cfrCode < 2299 },
    {
      code: 3998,
      sheet: 'B_Sheet',
      label: 'TOTAL SHAREHOLDER EQUITY',
      inputs: (v) => v.sheet === 'B_Sheet' && v.cfrCode >= 3800 && v.cfrCode < 3998,
    },
  ];
  for (const t of totalsChecks) {
    const total = values.find((v) => v.sheet === t.sheet && v.cfrCode === t.code && v.computed && v.value !== null);
    if (!total) continue;
    const sum = round2(
      values.filter((v) => !v.computed && v.value !== null && t.inputs(v)).reduce((a, v) => a + (v.value as number), 0)
    );
    if (Math.abs(Math.abs(total.value as number) - Math.abs(sum)) > 1) {
      findings.push({
        severity: 'warning',
        message:
          `Prior-year ${t.label} (${t.code}) is €${(total.value as number).toFixed(2)} but its input rows sum to ` +
          `€${sum.toFixed(2)} — the filed total does not tie to its own lines (stale recalc or hand-edited rows). ` +
          `Verify the prior return before relying on brought-forward figures.`,
      });
    }
  }
  return { findings, balanceSheetNet, impliedNetProfit, convention };
}
