/**
 * Parses raw client ETB spreadsheets (varying real-world layouts) into EtbAccount[].
 * Sign convention: Dr +, Cr −. Nothing is guessed silently: unparseable files throw,
 * imbalances and skipped rows come back as warnings for the preparer to see.
 */
import * as XLSX from 'xlsx';
import type { EtbAccount } from './domain';

export interface ParsedEtb {
  accounts: EtbAccount[];
  warnings: string[];
  headerRow: number;
  sheetName: string;
}

type ColKind = 'code' | 'name' | 'debit' | 'credit' | 'balance' | 'pyBalance' | 'pyDebit' | 'pyCredit';

const HEADER_PATTERNS: Array<{ kind: ColKind; re: RegExp }> = [
  { kind: 'pyDebit', re: /(prior|previous|py|comparat).*(debit|dr)|(debit|dr).*(prior|previous|py)/i },
  { kind: 'pyCredit', re: /(prior|previous|py|comparat).*(credit|cr)|(credit|cr).*(prior|previous|py)/i },
  { kind: 'pyBalance', re: /prior|previous|\bpy\b|comparat|last year/i },
  { kind: 'debit', re: /debit|\bdr\b/i },
  { kind: 'credit', re: /credit|\bcr\b/i },
  // 'balance' must never claim opening/brought-forward columns or Dr/Cr columns.
  {
    kind: 'balance',
    re: /^(?!.*(?:open(?:ing)?|\bb\/?f\b|brought\s*forward|debit|credit|\bdr\b|\bcr\b)).*(?:final|adjusted|closing|balance|amount|\btb\b|current)/i,
  },
  { kind: 'code', re: /^(a\/?c|n\/?c|nominal|acc(ount)?)\s*(code|no|number|ref)\.?$|^code\.?$|^ref\.?$|^n\/c$/i },
  { kind: 'name', re: /name|description|account|narrative|details/i },
];

function classify(header: string): ColKind | null {
  const h = header.trim();
  if (!h) return null;
  for (const p of HEADER_PATTERNS) if (p.re.test(h)) return p.kind;
  return null;
}

/**
 * Strict accountant-number parser. Accepts €/commas-as-thousands/spaces,
 * (x) negatives and trailing Dr/Cr suffixes; the ENTIRE remainder must be a
 * plain decimal or we return null (never a silently corrupted figure).
 */
function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  let sign = 1;
  // Trailing Dr/Cr suffix: Dr +, Cr − (applied before full-string validation).
  const drcr = s.match(/\s*(dr|cr)\.?$/i);
  if (drcr) {
    if (drcr[1].toLowerCase() === 'cr') sign = -1;
    s = s.slice(0, drcr.index).trim();
  }
  s = s.replace(/[€\s]/g, '');
  const paren = s.match(/^\((.*)\)$/);
  if (paren) {
    sign *= -1;
    s = paren[1];
  }
  // Commas are only accepted as genuine thousands groups (1,234 / 12,345,678.90).
  // Anything else (1.234,56 / 1234,56 / 1,23) is ambiguous or European
  // decimal-comma notation and would be corrupted by comma-stripping — reject.
  if (s.includes(',')) {
    if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s) * sign;
}

/** Classify one candidate header row into column roles. */
function classifyRow(row: unknown[]): {
  cols: Map<number, ColKind>;
  balanceHeaders: string[];
  isHeader: boolean;
} {
  const cols = new Map<number, ColKind>();
  const balanceHeaders: string[] = [];
  const yearCols: Array<{ c: number; year: number }> = [];
  row.forEach((cell, c) => {
    if (typeof cell === 'string') {
      const kind = classify(cell);
      if (kind === 'balance') balanceHeaders.push(cell.trim());
      if (kind && ![...cols.values()].includes(kind)) cols.set(c, kind);
    } else if (typeof cell === 'number' && Number.isInteger(cell) && cell >= 1990 && cell <= 2100) {
      yearCols.push({ c, year: cell });
    }
  });
  // Extended TBs head their closing-balance columns with the year itself
  // ("… | 2024 | … | 2023"); those supersede pre-adjustment text columns like
  // "Client TB", so the ambiguity is resolved deterministically: max year = CY,
  // next = PY.
  // (≥2 labelled columns required, so a data row whose balance happens to equal
  // a year number — e.g. €2024 — can't be mistaken for a header.)
  if (yearCols.length && cols.size >= 2) {
    yearCols.sort((a, b) => b.year - a.year);
    for (const [c, k] of [...cols]) if (k === 'balance' || k === 'pyBalance') cols.delete(c);
    cols.set(yearCols[0].c, 'balance');
    if (yearCols[1]) cols.set(yearCols[1].c, 'pyBalance');
    balanceHeaders.length = 0;
  }
  const kinds = new Set(cols.values());
  const hasAmount = kinds.has('balance') || (kinds.has('debit') && kinds.has('credit'));
  let hasName = kinds.has('name') || kinds.has('code');
  // Bare Dr/Cr trial balances (e.g. QuickBooks exports) label only the amount
  // columns; the unlabelled description column sits immediately to their left.
  // Restricted to true Debit+Credit pairs — a lone balance-ish word ("Bank
  // current account") must never turn a data row into a synthetic header.
  if (kinds.has('debit') && kinds.has('credit') && !hasName) {
    const amountCols = [...cols].filter(([, k]) => k !== 'name' && k !== 'code').map(([c]) => c);
    const left = Math.min(...amountCols) - 1;
    if (left >= 0 && !cols.has(left)) {
      cols.set(left, 'name');
      hasName = true;
    }
  }
  return { cols, balanceHeaders, isHeader: hasAmount && hasName };
}

export function parseEtb(buffer: Buffer): ParsedEtb {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let best: {
    score: number;
    sheet: string;
    row: number;
    cols: Map<number, ColKind>;
    balanceHeaders: string[];
  } | null = null;

  for (const sheetName of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null,
    });
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const { cols, balanceHeaders, isHeader } = classifyRow(rows[r] ?? []);
      if (isHeader) {
        const score = cols.size;
        if (!best || score > best.score) best = { score, sheet: sheetName, row: r, cols, balanceHeaders };
      }
    }
  }
  if (!best) throw new Error('Could not locate an ETB header row in any sheet (looked in first 30 rows).');
  if (best.balanceHeaders.length > 1) {
    throw new Error(
      `Ambiguous balance columns: ${best.balanceHeaders.map((h) => `"${h}"`).join(', ')} — please clarify the ETB layout.`
    );
  }

  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[best.sheet], {
    header: 1,
    raw: true,
    defval: null,
  });
  const col = (kind: ColKind): number | null => {
    for (const [c, k] of best!.cols) if (k === kind) return c;
    return null;
  };
  const cCode = col('code');
  const cName = col('name');
  const cDr = col('debit');
  const cCr = col('credit');
  const cBal = col('balance');
  const cPy = col('pyBalance');
  const cPyDr = col('pyDebit');
  const cPyCr = col('pyCredit');

  const warnings: string[] = [];
  const accounts: EtbAccount[] = [];
  for (let r = best.row + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    let name = cName != null ? String(row[cName] ?? '').trim() : '';
    const codeRaw = cCode != null ? row[cCode] : null;
    let code = codeRaw != null ? String(codeRaw).trim() : '';
    if (!name && !code) continue;
    // Repeated header rows inside the data region (title/units duplicates)
    // would otherwise parse as fake accounts — skip them LOUDLY.
    if (classifyRow(row).isHeader) {
      warnings.push(`Row ${r + 1} ("${name || code}") skipped as repeated header row.`);
      continue;
    }
    // Combined "0002000 BOV Bank" cells (no separate code column): split so the
    // code is usable for mapping rules and the name for interview triggers.
    if (!code) {
      const m = name.match(/^(\d{3,})\s+(.+)$/);
      if (m) {
        code = m[1];
        name = m[2];
      }
    }
    // Summary rows (totals, net assets/profit lines) are skipped LOUDLY so real
    // accounts like "Net wages payable" are never dropped invisibly.
    const summaryRe = /^(grand\s+)?total|^net (assets|liabilit|profit|loss|equity)/i;
    if (summaryRe.test(name) || summaryRe.test(code)) {
      warnings.push(`Row ${r + 1} ("${name || code}") skipped as summary row.`);
      continue;
    }

    let cy: number | null = null;
    if (cBal != null) cy = toNumber(row[cBal]);
    else if (cDr != null && cCr != null) {
      const dr = toNumber(row[cDr]) ?? 0;
      const cr = toNumber(row[cCr]) ?? 0;
      cy = dr - cr;
      if (toNumber(row[cDr]) === null && toNumber(row[cCr]) === null) cy = null;
    }
    if (cy === null) {
      if (name || code) warnings.push(`Row ${r + 1} ("${name || code}") skipped: no numeric balance.`);
      continue;
    }
    let py: number | null = null;
    if (cPy != null) py = toNumber(row[cPy]);
    else if (cPyDr != null && cPyCr != null) {
      const d = toNumber(row[cPyDr]);
      const c = toNumber(row[cPyCr]);
      py = d === null && c === null ? null : (d ?? 0) - (c ?? 0);
    }
    accounts.push({ accountCode: code || name, accountName: name || code, cyBalance: cy, pyBalance: py });
  }

  const sum = accounts.reduce((a, x) => a + x.cyBalance, 0);
  if (Math.abs(sum) > 1) warnings.push(`ETB does not balance: net ${sum.toFixed(2)} (should be 0).`);
  if (accounts.length === 0) throw new Error('Header row found but no account rows could be parsed.');
  return { accounts, warnings, headerRow: best.row, sheetName: best.sheet };
}
