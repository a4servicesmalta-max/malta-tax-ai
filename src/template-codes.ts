/**
 * Read the uploaded CfR template's ACTUAL data-entry code rows (sheet, code,
 * label). This is what makes mapping template-aware: proposals are constrained
 * to codes that really exist in THIS template, so nothing lands "unmatched"
 * and no section of the return stays silently empty.
 *
 * Reading uses SheetJS (fine for reads; the byte-exact JSZip writer is only
 * needed for writes). Convention matches the writer: column C = code,
 * column B = row label, column E = value.
 */
import * as XLSX from 'xlsx';
import type { CfrSheet } from './domain';

export interface TemplateCode {
  sheet: CfrSheet;
  code: number;
  label: string;
}

const CODE_SHEETS: CfrSheet[] = ['B_Sheet', 'Income'];

export function readTemplateCodes(buffer: Buffer): TemplateCode[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', sheets: CODE_SHEETS as unknown as string[] });
  } catch {
    return [];
  }
  const out: TemplateCode[] = [];
  for (const sheet of CODE_SHEETS) {
    const ws = wb.Sheets[sheet];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= range.e.r; r++) {
      const codeCell = ws[XLSX.utils.encode_cell({ r, c: 2 })]; // column C
      if (!codeCell || typeof codeCell.v !== 'number' || !Number.isInteger(codeCell.v)) continue;
      const labelCell = ws[XLSX.utils.encode_cell({ r, c: 1 })]; // column B
      const label = labelCell && typeof labelCell.v === 'string' ? labelCell.v.trim().slice(0, 120) : '';
      out.push({ sheet, code: codeCell.v, label });
    }
  }
  return out;
}

/** Fast membership lookup: "B_Sheet:1001" → true. */
export function codeKeySet(codes: TemplateCode[]): Set<string> {
  return new Set(codes.map((c) => `${c.sheet}:${c.code}`));
}
