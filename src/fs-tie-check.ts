/**
 * FS tie-check: does the mapped ETB reproduce the signed FS?
 * v1 compares two headline figures — net profit and total assets. Figures come
 * from a best-effort label scan of the FS Excel, or the preparer types them.
 * A failed tie never blocks silently: it produces explicit warnings, and
 * figures that could not even be compared are surfaced as 'not-compared'.
 */
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// pdf-parse's index.js runs debug code when it thinks it's the entrypoint;
// require the lib directly. Typed minimally — we only use .text.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>;

export interface FsFigures {
  netProfit: number | null;
  totalAssets: number | null;
  /** Line-by-line extensions — optional so absent FS lines stay quiet. */
  revenue?: number | null;
  totalEquity?: number | null;
  totalLiabilities?: number | null;
  /** Date the FS were approved/signed by the board (ISO yyyy-mm-dd) — feeds the p8 declaration date. */
  approvalDate?: string | null;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * The board-approval date from the FS text: "approved and authorised for
 * issue by the board of directors on 27th October 2025 and were signed by".
 * PDF extraction can space the ordinal ("27 th"), so the suffix is optional
 * and detached. Numeric dd/mm/yyyy near the approval phrase also accepted.
 */
export function extractApprovalDate(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const scopes = [...flat.matchAll(/(?:approved|authorised for issue|signed)[^.]{0,120}/gi)].map((m) => m[0]);
  const MON = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const iso = (day: number, month: number, year: number): string | null =>
    day >= 1 && day <= 31 && month >= 1 && month <= 12
      ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : null;
  for (const scope of scopes) {
    // A single approval sentence often carries TWO dates — the accounting
    // period-end ("for the year ended 31 December 2024") and the board-approval
    // date ("... on 27 October 2025"). We want the approval date: prefer a date
    // introduced by "on", and never a date introduced by "ended"/"ending".
    const worded = [
      ...scope.matchAll(new RegExp(`(\\b[a-z]+\\b)\\s+(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(${MON})[ ,]+(\\d{4})\\b`, 'gi')),
    ];
    const isPeriodEnd = (w: string) => /^end(?:ed|ing)?$/i.test(w);
    const pickW = worded.find((m) => /^on$/i.test(m[1])) ?? worded.find((m) => !isPeriodEnd(m[1]));
    if (pickW) {
      const date = iso(parseInt(pickW[2], 10), MONTHS[pickW[3].toLowerCase()], parseInt(pickW[4], 10));
      if (date) return date;
    }
    const numeric = [...scope.matchAll(/(\b[a-z]+\b\s+)?(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/gi)];
    const pickN = numeric.find((m) => /^on\s+$/i.test(m[1] ?? '')) ?? numeric.find((m) => !isPeriodEnd((m[1] ?? '').trim()));
    if (pickN) {
      const date = iso(parseInt(pickN[2], 10), parseInt(pickN[3], 10), parseInt(pickN[4], 10));
      if (date) return date;
    }
  }
  return null;
}

// Anchored to the whole trimmed label so note text ("the net profit margin")
// can never match. Accepts profit and loss forms: "Profit for the year",
// "Loss for the year", "(Loss) for the year", "Profit/(loss) for the period",
// "Net profit", "Net loss", and — matched FIRST because it prints ABOVE the
// after-tax line in an income statement — "Profit/(loss) before tax(ation)".
// The CfR return's field 1a (p3!E6) is net profit BEFORE tax, so tying against
// the FS before-tax figure (when present) avoids a false mismatch equal to the
// tax charge; the after-tax "for the year" line is the fallback.
const NET_PROFIT_RE =
  /^\(?(?:profit|loss)\)?\s*(?:\/?\s*\(?(?:loss|profit)\)?)?\s*before tax(?:ation)?$|^\(?(?:profit|loss)\)?\s*(?:\/?\s*\(?(?:loss|profit)\)?)?\s*for the (?:year|period)$|^net (?:profit|loss)$/i;
const TOTAL_ASSETS_RE = /^total assets$/i;

/** All tie-able FS lines. "total equity(?! and)" keeps "Total equity and liabilities" out. */
type FigureKey = Exclude<keyof FsFigures, 'approvalDate'>;
const FIGURE_LABELS: Record<FigureKey, RegExp> = {
  netProfit: NET_PROFIT_RE,
  totalAssets: TOTAL_ASSETS_RE,
  revenue: /^(?:total )?(?:revenue|turnover)$/i,
  totalEquity: /^total (?:equity(?! and)|shareholders?'? (?:funds|equity))$/i,
  totalLiabilities: /^total liabilities$/i,
};
const FIGURE_KEYS = Object.keys(FIGURE_LABELS) as Array<FigureKey>;
const emptyFigures = (): FsFigures => ({
  netProfit: null,
  totalAssets: null,
  revenue: null,
  totalEquity: null,
  totalLiabilities: null,
});

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

/** Parse an accountant-formatted number token: 1,234,567.89 / (1,234) negatives. */
function parseAmount(tok: string): number | null {
  let s = tok.trim();
  let sign = 1;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    sign = -1;
    s = paren[1];
  }
  s = s.replace(/[€\s]/g, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * sign;
}

/**
 * Same label-scan as the spreadsheet path, over plain text lines (PDF/DOCX
 * text). Label = the line with its trailing numbers stripped; figures = the
 * numeric tokens on the line, run through the same note-column heuristic.
 */
export function extractFiguresFromText(text: string): FsFigures {
  const out = emptyFigures();
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const numsOf = (line: string): number[] =>
    (line.match(/\(?-?€?\s?[\d,]+(?:\.\d+)?\)?/g) ?? [])
      .map(parseAmount)
      .filter((n): n is number => n !== null && isFinite(n));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let nums = numsOf(line);
    const label = line.replace(/[\d,().€\s-]+$/g, '').trim();
    if (!label || !FIGURE_KEYS.some((k) => FIGURE_LABELS[k].test(label))) continue;
    // Columnar PDFs often put the amounts on the following line(s): a matching
    // label with no figures borrows the first nearby numbers-only line.
    if (!nums.length) {
      let seen = 0;
      for (let j = i + 1; j < lines.length && seen < 2; j++) {
        const next = lines[j];
        if (!next) continue; // skip blank spacer lines entirely
        seen++;
        const nextNums = numsOf(next);
        const nextLabel = next.replace(/[\d,().€\s-]+$/g, '').trim();
        if (nextNums.length && !nextLabel) {
          nums = nextNums;
          break;
        }
        if (nextLabel) break; // another labelled row — don't steal its figures
      }
    }
    if (!nums.length) continue;
    const fig = pickRowFigure(nums);
    if (fig === undefined) continue;
    for (const k of FIGURE_KEYS) {
      if (out[k] === null && FIGURE_LABELS[k].test(label)) out[k] = fig;
    }
  }
  return out;
}

export function extractFsFigures(buffer: Buffer): FsFigures {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  // Income-statement-like sheets first; all remaining sheets as fallback.
  const ordered = [
    ...wb.SheetNames.filter((n) => INCOME_SHEET_RE.test(n)),
    ...wb.SheetNames.filter((n) => !INCOME_SHEET_RE.test(n)),
  ];
  const out = emptyFigures();
  for (const name of ordered) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    for (const row of rows) {
      const label = row.find((c) => typeof c === 'string') as string | undefined;
      if (!label) continue;
      const fig = pickRowFigure(row);
      if (fig === undefined) continue;
      for (const k of FIGURE_KEYS) {
        if (out[k] === null && FIGURE_LABELS[k].test(label.trim())) out[k] = fig;
      }
    }
  }
  return out;
}

/**
 * Any-format FS intake: PDF, Word, Excel, CSV or text. Best-effort — the FS
 * feeds only the advisory tie-check, so an unreadable file NEVER blocks the
 * flow; it returns null figures plus a plain-English note for the preparer.
 */
export async function extractFsFiguresAny(
  buffer: Buffer,
  filename: string
): Promise<{ figures: FsFigures; note: string | null }> {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const none: FsFigures = { netProfit: null, totalAssets: null };
  try {
    let figures: FsFigures;
    if (ext === 'pdf') {
      const { text } = await pdfParse(buffer);
      figures = extractFiguresFromText(text || '');
      figures.approvalDate = extractApprovalDate(text || '');
    } else if (ext === 'docx' || ext === 'doc') {
      // DOCX is a zip; pull the main document XML and strip tags. (.doc binary
      // isn't parseable this way — the catch below reports it plainly.)
      const zip = await JSZip.loadAsync(buffer);
      const xml = await zip.file('word/document.xml')?.async('string');
      if (!xml) throw new Error('no document.xml');
      const text = xml
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      figures = extractFiguresFromText(text);
      figures.approvalDate = extractApprovalDate(text);
    } else {
      // Excel / CSV / plain text — SheetJS parses all of these from a buffer.
      figures = extractFsFigures(buffer);
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const textBlob = wb.SheetNames.map((n) =>
        XLSX.utils
          .sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: false, defval: '' })
          .map((r) => r.join(' '))
          .join('\n')
      ).join('\n');
      figures.approvalDate = extractApprovalDate(textBlob);
    }
    const note =
      figures.netProfit === null && figures.totalAssets === null
        ? `Financial statements ("${filename}") were uploaded but the net profit / total assets figures could not be read automatically — the FS tie-check will ask you to verify manually.`
        : null;
    return { figures, note };
  } catch {
    return {
      figures: none,
      note: `Financial statements ("${filename}") could not be read (${ext ? '.' + ext : 'unknown format'}). The return is unaffected — the FS tie-check is skipped; verify the figures manually.`,
    };
  }
}

export type TieCheckStatus = 'tied' | 'mismatch' | 'not-compared';

export interface TieResult {
  ok: boolean;
  issues: string[];
  checks: { netProfit: TieCheckStatus; totalAssets: TieCheckStatus } & Partial<
    Record<'revenue' | 'totalEquity' | 'totalLiabilities', TieCheckStatus>
  >;
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

  // Line-by-line extensions: compared on magnitude (FS statements print
  // positives; the mapped derivation is signed). Skipped silently when the FS
  // doesn't carry the line at all — only a real disagreement makes noise.
  const checks: TieResult['checks'] = { netProfit, totalAssets };
  const extended: Array<{ key: 'revenue' | 'totalEquity' | 'totalLiabilities'; label: string }> = [
    { key: 'revenue', label: 'Revenue' },
    { key: 'totalEquity', label: 'Total equity' },
    { key: 'totalLiabilities', label: 'Total liabilities' },
  ];
  let extendedMismatch = false;
  for (const { key, label } of extended) {
    const f = fs[key];
    const e = etbDerived[key];
    if (f === null || f === undefined || e === null || e === undefined) continue;
    const d = Math.abs(Math.abs(f) - Math.abs(e));
    if (d > TOL) {
      checks[key] = 'mismatch';
      extendedMismatch = true;
      issues.push(
        `${label} does not tie: FS €${Math.abs(f).toFixed(2)} vs return €${Math.abs(e).toFixed(2)} (difference €${d.toFixed(2)}).`
      );
    } else {
      checks[key] = 'tied';
    }
  }

  return { ok: netProfit !== 'mismatch' && totalAssets !== 'mismatch' && !extendedMismatch, issues, checks };
}
