/**
 * Reads (sheet, CfR code, value) triples from a filled CfR workbook.
 * Column C = CfR code, column E = value — same convention the writer uses.
 * Used for: recovering the code set of a prior-year return, replay diffs.
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

function detectPrefix(xml: string): string {
  const m = xml.match(/<(\w+:)?(?:workbook|worksheet|sheetData|sheets|row|c)\b/);
  return m && m[1] ? m[1] : '';
}

async function sheetPaths(zip: JSZip): Promise<Record<string, string>> {
  const wbXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
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
    if (!path) continue;
    const xml = await zip.file(path)!.async('string');
    const p = detectPrefix(xml);
    const codeRe = new RegExp(
      `<${p}c\\b[^>]*\\br="C(\\d+)"[^>]*>(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*(\\d+)\\s*</${p}v>`,
      'g'
    );
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(xml))) {
      const row = parseInt(m[1], 10);
      const cfrCode = parseInt(m[2], 10);
      const eRe = new RegExp(
        `<${p}c\\b[^>]*\\br="E${row}"[^>]*>(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*(-?[\\d.eE+]+)\\s*</${p}v>`
      );
      const em = xml.match(eRe);
      out.push({ sheet, cfrCode, row, value: em ? parseFloat(em[1]) : null });
    }
  }
  return out;
}
