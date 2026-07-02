/**
 * FS tie-check: does the mapped ETB reproduce the signed FS?
 * v1 compares two headline figures — net profit and total assets. Figures come
 * from a best-effort label scan of the FS Excel, or the preparer types them.
 * A failed tie never blocks silently: it produces explicit warnings.
 */
import * as XLSX from 'xlsx';

export interface FsFigures {
  netProfit: number | null;
  totalAssets: number | null;
}

const NET_PROFIT_RE = /profit\s*(?:\/?\s*\(?loss\)?)?\s*for the (?:year|period)|net profit/i;
const TOTAL_ASSETS_RE = /^total assets$/i;

export function extractFsFigures(buffer: Buffer): FsFigures {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let netProfit: number | null = null;
  let totalAssets: number | null = null;
  for (const name of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    for (const row of rows) {
      const label = row.find((c) => typeof c === 'string') as string | undefined;
      if (!label) continue;
      const firstNum = row.find((c) => typeof c === 'number') as number | undefined;
      if (firstNum === undefined) continue;
      if (netProfit === null && NET_PROFIT_RE.test(label.trim())) netProfit = firstNum;
      if (totalAssets === null && TOTAL_ASSETS_RE.test(label.trim())) totalAssets = firstNum;
    }
  }
  return { netProfit, totalAssets };
}

export interface TieResult {
  ok: boolean;
  issues: string[];
}

const TOL = 1; // €1 tolerance for rounding

export function tieCheck(fs: FsFigures, etbDerived: FsFigures): TieResult {
  const issues: string[] = [];
  if (fs.netProfit !== null && etbDerived.netProfit !== null) {
    const d = Math.abs(fs.netProfit - etbDerived.netProfit);
    if (d > TOL)
      issues.push(
        `Net profit does not tie: FS €${fs.netProfit.toFixed(2)} vs ETB-derived €${etbDerived.netProfit.toFixed(2)} (difference €${d.toFixed(2)}).`
      );
  }
  if (fs.totalAssets !== null && etbDerived.totalAssets !== null) {
    const d = Math.abs(fs.totalAssets - etbDerived.totalAssets);
    if (d > TOL)
      issues.push(
        `Total assets do not tie: FS €${fs.totalAssets.toFixed(2)} vs ETB-derived €${etbDerived.totalAssets.toFixed(2)} (difference €${d.toFixed(2)}).`
      );
  }
  return { ok: issues.length === 0, issues };
}
