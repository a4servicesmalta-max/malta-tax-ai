/**
 * Reads (sheet, CfR code, value) triples from a filled CfR workbook.
 * Column C = CfR code, column E = value — same convention the writer uses.
 * Used for: recovering the code set of a prior-year return, replay diffs.
 * The small regex helpers below are intentional copies of the writer's private
 * utilities — do not unify; coupling reader to writer internals would make the
 * ported writer harder to keep in sync with its upstream source.
 */
import JSZip from 'jszip';

export interface CfrValue {
  sheet: string;
  cfrCode: number;
  row: number;
  value: number | null;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/** True when a cell opening tag holds a non-numeric type (e.g. t="s" shared string). */
function isNonNumericCell(openTag: string): boolean {
  const t = attr(openTag, 't');
  return t !== undefined && t !== 'n';
}

function detectPrefix(xml: string): string {
  const m = xml.match(/<(\w+:)?(?:workbook|worksheet|sheetData|sheets|row|c)\b/);
  return m && m[1] ? m[1] : '';
}

async function sheetPaths(zip: JSZip): Promise<Record<string, string>> {
  const wbFile = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!wbFile || !relsFile) throw new Error('Not a valid xlsx: missing workbook.xml or rels');
  const wbXml = await wbFile.async('string');
  const relsXml = await relsFile.async('string');
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
    if (!name || !rid || !relTarget[rid]) continue;
    const t = relTarget[rid];
    out[name] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  }
  return out;
}

export async function listSheetNames(workbook: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(workbook);
  return Object.keys(await sheetPaths(zip));
}

export async function readCfrValues(workbook: Buffer, sheets: string[]): Promise<CfrValue[]> {
  const zip = await JSZip.loadAsync(workbook);
  const paths = await sheetPaths(zip);
  const out: CfrValue[] = [];
  for (const sheet of sheets) {
    const path = paths[sheet];
    if (!path) throw new Error(`Sheet "${sheet}" not found in workbook`);
    const file = zip.file(path);
    if (!file) throw new Error(`Not a valid xlsx: worksheet xml ${path} missing`);
    const xml = await file.async('string');
    const p = detectPrefix(xml);
    const codeRe = new RegExp(
      `(<${p}c\\b[^>]*\\br="C(\\d+)"[^>]*>)(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*(\\d+)\\s*</${p}v>`,
      'g'
    );
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(xml))) {
      if (isNonNumericCell(m[1])) continue; // e.g. shared-string label, not a CfR code
      const row = parseInt(m[2], 10);
      const cfrCode = parseInt(m[3], 10);
      const eRe = new RegExp(
        `(<${p}c\\b[^>]*\\br="E${row}"[^>]*>)(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*</${p}v>`
      );
      const em = xml.match(eRe);
      const value = em && !isNonNumericCell(em[1]) ? parseFloat(em[2]) : null;
      out.push({ sheet, cfrCode, row, value });
    }
  }
  return out;
}
