/**
 * Server-side OOXML writer for the CfR return template.
 * Ported from vacei-stack _reint_be maltaCit.template-writer.ts (feat/malta-cit-tax-return).
 *
 * Why not exceljs: it cannot even READ this 128/135-sheet template. So we edit
 * the .xlsx as a zip and touch ONLY the target cell values, leaving every
 * formula, named range, style and the `exportmap` byte-intact. We then set
 * `fullCalcOnLoad="1"` so the preparer's Excel recomputes the whole return
 * (statements + tax) on open — no Excel/LibreOffice needed on the server.
 *
 * Cells are located by CfR account CODE (column C of B_Sheet/Income), never by
 * fixed address — the CfR reissues the template every Year of Assessment and
 * rows shift. Direct-address writes (e.g. p3!E6 net profit) are also supported.
 *
 * NOTE: CfR files vary in OOXML serialization — some use an `x:` element-name
 * prefix (`<x:sheet>`, `<x:c>`, `<x:v>`), others are unprefixed. We detect the
 * prefix per part and emit markup with the SAME prefix; writing unprefixed
 * elements into a prefixed file would land them in the wrong namespace.
 */
import JSZip from 'jszip';

/** Write a value into the value column (E) of the row whose CfR code matches. */
export interface CfrCodeCell {
  sheet: string; // e.g. 'B_Sheet' | 'Income'
  cfrCode: number; // CfR account code in column C
  amount: number; // Dr (+) / Cr (-)
}

/** Write a value into a specific cell address (e.g. p3!E6 net profit per FS). */
export interface CfrDirectCell {
  sheet: string;
  ref: string; // e.g. 'E6'
  /** Numbers are figures; strings are description text for "[Please specify below]" rows. */
  value: number | string;
}

export interface FillResult {
  buffer: Buffer;
  /** Codes that had no matching row (surfaced for review, never silently dropped). */
  unmatched: Array<{ sheet: string; cfrCode: number }>;
}

const WORKBOOK = 'xl/workbook.xml';
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';
const VALUE_COL = 'E';

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/** Detect the element-name prefix used in an OOXML part ('' or e.g. 'x:'). */
function detectPrefix(xml: string): string {
  const m = xml.match(/<(\w+:)?(?:workbook|worksheet|sheetData|sheets|row|c)\b/);
  return m && m[1] ? m[1] : '';
}

/** Map worksheet display name -> zip path (e.g. 'B_Sheet' -> 'xl/worksheets/sheet4.xml'). */
function sheetPathMap(wbXml: string, relsXml: string): Record<string, string> {
  const relTarget: Record<string, string> = {};
  const rp = relsXml.match(/<(\w+:)?Relationship\b/)?.[1] ?? '';
  for (const m of relsXml.matchAll(new RegExp(`<${rp}Relationship\\b[^>]*>`, 'g'))) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTarget[id] = target;
  }
  const p = detectPrefix(wbXml);
  const out: Record<string, string> = {};
  for (const m of wbXml.matchAll(new RegExp(`<${p}sheet\\b[^>]*?/?>`, 'g'))) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    if (!name || !rid) continue;
    const target = relTarget[rid];
    if (!target) continue;
    out[name] = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  return out;
}

function colNum(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Find the row number whose column-C cell holds the given CfR code. */
function rowOfCode(sheetXml: string, code: number, p: string): number | null {
  const re = new RegExp(
    `<${p}c\\b[^>]*\\br="C(\\d+)"[^>]*>(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*${code}\\s*</${p}v>`,
    'g'
  );
  const m = re.exec(sheetXml);
  return m ? parseInt(m[1], 10) : null;
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Set a value into `ref`, preserving the cell's style; insert in column order if absent. */
function setCell(sheetXml: string, ref: string, value: number | string, p: string): string {
  const rowNum = ref.match(/\d+$/)![0];
  const rowRe = new RegExp(`(<${p}row\\b[^>]*\\br="${rowNum}"[^>]*>)([\\s\\S]*?)(</${p}row>)`);
  const rm = sheetXml.match(rowRe);
  if (!rm) throw new Error(`row ${rowNum} not present in sheet for ${ref}`);
  let inner = rm[2];

  const cellRe = new RegExp(`<${p}c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</${p}c>)`);
  const existing = inner.match(cellRe);
  const style = existing ? attr(existing[0], 's') : undefined;
  const sAttr = style ? ` s="${style}"` : '';
  const newCell =
    typeof value === 'string'
      ? `<${p}c r="${ref}"${sAttr} t="inlineStr"><${p}is><${p}t xml:space="preserve">${escXml(value)}</${p}t></${p}is></${p}c>`
      : `<${p}c r="${ref}"${sAttr}><${p}v>${value}</${p}v></${p}c>`;

  if (existing) {
    inner = inner.replace(cellRe, newCell);
  } else {
    const target = colNum(ref);
    const cellTagRe = new RegExp(
      `<${p}c\\b[^>]*\\br="([A-Z]+\\d+)"[^>]*?(?:/>|>[\\s\\S]*?</${p}c>)`,
      'g'
    );
    let insertAt = inner.length;
    let m: RegExpExecArray | null;
    while ((m = cellTagRe.exec(inner))) {
      if (colNum(m[1]) > target) {
        insertAt = m.index;
        break;
      }
    }
    inner = inner.slice(0, insertAt) + newCell + inner.slice(insertAt);
  }
  // Function replacer: a string replacement would corrupt content containing
  // `$` patterns (e.g. absolute refs like $E$10 — JS treats `$1` as a backref).
  return sheetXml.replace(rowRe, (_all, open, _inner, close) => open + inner + close);
}

/**
 * Blank a cell's VALUE while preserving the cell (and its style). Used to
 * clear preparer-typed figures left in a non-blank "template": stale values on
 * rows the engine did not write would otherwise survive into the produced
 * return and silently double-count against the engine's own figures.
 */
function clearCell(sheetXml: string, ref: string, p: string): string {
  const cellRe = new RegExp(`<${p}c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</${p}c>)`);
  const existing = sheetXml.match(cellRe);
  if (!existing) return sheetXml; // nothing there — already blank
  const style = attr(existing[0], 's');
  return sheetXml.replace(cellRe, `<${p}c r="${ref}"${style ? ` s="${style}"` : ''}/>`);
}

/** Force Excel to fully recalculate when the file is opened. */
function setFullCalcOnLoad(wbXml: string): string {
  const p = detectPrefix(wbXml);
  if (new RegExp(`<${p}calcPr\\b[^>]*/>`).test(wbXml)) {
    if (/fullCalcOnLoad=/.test(wbXml))
      return wbXml.replace(/fullCalcOnLoad="0"/, 'fullCalcOnLoad="1"');
    return wbXml.replace(
      new RegExp(`<${p}calcPr\\b([^>]*?)\\s*/>`),
      `<${p}calcPr$1 fullCalcOnLoad="1"/>`
    );
  }
  if (!new RegExp(`<${p}calcPr`).test(wbXml)) {
    return wbXml.replace(new RegExp(`(</${p}sheets>)`), `$1<${p}calcPr fullCalcOnLoad="1"/>`);
  }
  return wbXml;
}

/**
 * Populate a CfR return template from mapped figures.
 * Returns the new .xlsx as a Buffer plus any unmatched codes for review.
 */
export async function fillCfrReturn(
  templateBuffer: Buffer,
  codeCells: CfrCodeCell[],
  directCells: CfrDirectCell[] = [],
  /** Code rows whose typed template values must be BLANKED (stale residue on a non-blank template). */
  clearCodeCells: Array<{ sheet: string; cfrCode: number }> = []
): Promise<FillResult> {
  const zip = await JSZip.loadAsync(templateBuffer);
  const wbFile = zip.file(WORKBOOK);
  const relsFile = zip.file(WORKBOOK_RELS);
  if (!wbFile || !relsFile) throw new Error('Not a valid xlsx: missing workbook.xml or rels');

  const wbXml = await wbFile.async('string');
  const relsXml = await relsFile.async('string');
  const pathMap = sheetPathMap(wbXml, relsXml);

  type Write = { ref?: string; code?: number; value: number | string; clear?: boolean };
  const bySheet = new Map<string, Write[]>();
  const add = (sheet: string, w: Write) => {
    if (!bySheet.has(sheet)) bySheet.set(sheet, []);
    bySheet.get(sheet)!.push(w);
  };
  // Clears first: a row must never end up cleared after being written.
  for (const c of clearCodeCells) add(c.sheet, { code: c.cfrCode, value: 0, clear: true });
  for (const c of codeCells) add(c.sheet, { code: c.cfrCode, value: c.amount });
  for (const d of directCells) add(d.sheet, { ref: d.ref, value: d.value });

  const unmatched: FillResult['unmatched'] = [];
  for (const [sheet, writes] of bySheet) {
    const path = pathMap[sheet];
    if (!path) throw new Error(`Sheet "${sheet}" not found in template`);
    const file = zip.file(path);
    if (!file) throw new Error(`Worksheet xml ${path} missing`);
    let xml = await file.async('string');
    const p = detectPrefix(xml);
    for (const w of writes) {
      let ref = w.ref;
      if (!ref && w.code != null) {
        const row = rowOfCode(xml, w.code, p);
        if (row == null) {
          // A clear target that no longer resolves is already effectively blank.
          if (!w.clear) unmatched.push({ sheet, cfrCode: w.code });
          continue;
        }
        ref = `${VALUE_COL}${row}`;
      }
      if (!ref) continue;
      xml = w.clear ? clearCell(xml, ref, p) : setCell(xml, ref, w.value, p);
    }
    zip.file(path, xml);
  }
  zip.file(WORKBOOK, setFullCalcOnLoad(wbXml));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, unmatched };
}
