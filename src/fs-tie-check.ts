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
  let netProfit: number | null = null;
  let totalAssets: number | null = null;
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
    if (!label || !(NET_PROFIT_RE.test(label) || TOTAL_ASSETS_RE.test(label))) continue;
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
    if (netProfit === null && NET_PROFIT_RE.test(label)) netProfit = fig;
    if (totalAssets === null && TOTAL_ASSETS_RE.test(label)) totalAssets = fig;
  }
  return { netProfit, totalAssets };
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
    } else {
      // Excel / CSV / plain text — SheetJS parses all of these from a buffer.
      figures = extractFsFigures(buffer);
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
