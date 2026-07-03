/**
 * FS tie-check: does the mapped ETB reproduce the signed FS?
 * v1 compares two headline figures — net profit and total assets. Figures come
 * from a best-effort label scan of the FS Excel, or the preparer types them.
 * A failed tie never blocks silently: it produces explicit warnings, and
 * figures that could not even be compared are surfaced as 'not-compared'.
 */
import * as XLSX from 'xlsx';

export interface FsFigures {
  netProfit: number | null;
  totalAssets: number | null;
}

// Anchored to the whole trimmed label so note text ("the net profit margin")
// can never match. Accepts profit and loss forms: "Profit for the year",
// "Loss for the year", "(Loss) for the year", "Profit/(loss) for the period",
// "Net profit", "Net loss".
const NET_PROFIT_RE =
  /^\(?(?:profit|loss)\)?\s*(?:\/?\s*\(?(?:loss|profit)\)?)?\s*for the (?:year|period)$|^net (?:profit|loss)$/i;
const TOTAL_ASSETS_RE = /^total assets$/i;

/** Sheets likely to hold the income statement — scanned first so notes sheets cannot lock in a wrong figure. */
const INCOME_SHEET_RE = /income|comprehensive|soci|p\s*&\s*l/i;

/**
 * Pick the figure from a labelled row. FS rows often carry a note-reference
 * column before the amounts (e.g. ['Total assets', 12, 3500000, 3200000]);
 * skip small leading integers when a much larger amount follows, then take the
 * FIRST remaining numeric (CY precedes PY in FS layouts).
 */
function pickRowFigure(row: unknown[]): number | undefined {
  const nums = row.filter((c): c is number => typeof c === 'number' && isFinite(c));
  if (nums.length === 0) return undefined;
  let i = 0;
  while (
    i < nums.length - 1 &&
    Number.isInteger(nums[i]) &&
    Math.abs(nums[i]) <= 200 &&
    nums.slice(i + 1).some((n) => Math.abs(n) > 10 * Math.abs(nums[i]))
  ) {
    i++;
  }
  return nums[i];
}

export function extractFsFigures(buffer: Buffer): FsFigures {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  // Income-statement-like sheets first; all remaining sheets as fallback.
  const ordered = [
    ...wb.SheetNames.filter((n) => INCOME_SHEET_RE.test(n)),
    ...wb.SheetNames.filter((n) => !INCOME_SHEET_RE.test(n)),
  ];
  let netProfit: number | null = null;
  let totalAssets: number | null = null;
  for (const name of ordered) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    for (const row of rows) {
      const label = row.find((c) => typeof c === 'string') as string | undefined;
      if (!label) continue;
      const fig = pickRowFigure(row);
      if (fig === undefined) continue;
      if (netProfit === null && NET_PROFIT_RE.test(label.trim())) netProfit = fig;
      if (totalAssets === null && TOTAL_ASSETS_RE.test(label.trim())) totalAssets = fig;
    }
  }
  return { netProfit, totalAssets };
}

export type TieCheckStatus = 'tied' | 'mismatch' | 'not-compared';

export interface TieResult {
  ok: boolean;
  issues: string[];
  checks: { netProfit: TieCheckStatus; totalAssets: TieCheckStatus };
}

const TOL = 1; // €1 tolerance for rounding

export function tieCheck(fs: FsFigures, etbDerived: FsFigures): TieResult {
  const issues: string[] = [];

  let netProfit: TieCheckStatus;
  if (fs.netProfit === null || etbDerived.netProfit === null) {
    netProfit = 'not-compared';
    issues.push(
      fs.netProfit === null
        ? 'Net profit could not be compared — figure not found in FS; verify manually.'
        : 'Net profit could not be compared — ETB-derived figure unavailable; verify manually.'
    );
  } else {
    const d = Math.abs(fs.netProfit - etbDerived.netProfit);
    if (d > TOL) {
      netProfit = 'mismatch';
      issues.push(
        `Net profit does not tie: FS €${fs.netProfit.toFixed(2)} vs ETB-derived €${etbDerived.netProfit.toFixed(2)} (difference €${d.toFixed(2)}).`
      );
    } else {
      netProfit = 'tied';
    }
  }

  let totalAssets: TieCheckStatus;
  if (fs.totalAssets === null || etbDerived.totalAssets === null) {
    totalAssets = 'not-compared';
    issues.push(
      fs.totalAssets === null
        ? 'Total assets could not be compared — figure not found in FS; verify manually.'
        : 'Total assets could not be compared — ETB-derived figure unavailable; verify manually.'
    );
  } else {
    const d = Math.abs(fs.totalAssets - etbDerived.totalAssets);
    if (d > TOL) {
      totalAssets = 'mismatch';
      issues.push(
        `Total assets do not tie: FS €${fs.totalAssets.toFixed(2)} vs ETB-derived €${etbDerived.totalAssets.toFixed(2)} (difference €${d.toFixed(2)}).`
      );
    } else {
      totalAssets = 'tied';
    }
  }

  return { ok: netProfit !== 'mismatch' && totalAssets !== 'mismatch', issues, checks: { netProfit, totalAssets } };
}
