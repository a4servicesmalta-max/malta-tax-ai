/**
 * Blank a filed CfR return into a reusable template.
 *
 * Discriminator: cross-client diff. A constant cell whose resolved value is
 * IDENTICAL in a same-vintage reference return (different client) is template
 * furniture — kept. A constant that differs / exists only in the target is
 * client data — cleared (style preserved). Where the reference carries a
 * FORMULA at a ref the target has as a constant, the preparer force-typed over
 * the template formula — the reference's formula is restored.
 *
 * Known preparer cells identical across clients (attachment flags, p2
 * defaults, name/TIN) are force-cleared regardless.
 *
 * Usage: npx tsx scripts/blank-return.mts <filed.xlsx> <out.xlsx> --ref <other-client-same-vintage.xlsx> [--ref <another.xlsx>] [--scrub]
 *
 * --scrub makes the blank PUBLISHABLE: clears every cached formula value
 * (except the TA2_e-CO_* version strings, kept for vintage detection), empties
 * unreferenced sharedStrings entries in place (indices untouched), and strips
 * document authors. fullCalcOnLoad recomputes everything on first open.
 */
import JSZip from 'jszip';
import fs from 'fs';

// Preparer-typed cells the cross-client diff cannot catch (identical answers
// across clients). The template's own required-input markers (IF(x="",re,…))
// are force-cleared too — a value at a required-input ref is client data by
// definition, even when every client answers it the same way.
const FORCE_CLEAR: Array<[string, string]> = [
  ['p1', 'AG8'], // TIN
  ['p1', 'L10'], // company name
  ['TRA111', 'K6'], ['TRA111', 'K11'], ['TRA111', 'N11'], // ATAD Reg 4 answers (not required-marked)
  ['TRA73', 'H120'], ['TRA73', 'H122'], // EV wear-and-tear answer + flag (conditionally marked)
];

/** Refs declared mandatory by the sheet's own IF(<ref>="",re,…) markers. */
function requiredRefs(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<f[^>]*>([^<]*)<\/f>/g))
    for (const rm of m[1].matchAll(/IF\(\s*\$?([A-Z]{1,2})\$?(\d+)\s*=\s*(?:""|&quot;&quot;)\s*,\s*re\s*[,)]/g))
      out.add(`${rm[1]}${rm[2]}`);
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : undefined;
}
function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CellInfo { formula?: string; value?: string; raw: string }
type SheetCells = Map<string, CellInfo>; // ref -> info

async function loadReturn(path: string) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path));
  const wbXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const sst: string[] = [];
  for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g))
    sst.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
  const relTarget: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), t = attr(m[0], 'Target');
    if (id && t) relTarget[id] = t;
  }
  const sheets = new Map<string, string>(); // name -> zip path
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id');
    if (name && rid && relTarget[rid])
      sheets.set(name, 'xl/' + relTarget[rid].replace(/^\//, '').replace(/^xl\//, ''));
  }
  return { zip, wbXml, sst, sheets };
}

function parseCells(xml: string, sst: string[]): SheetCells {
  const out: SheetCells = new Map();
  // NB: lazy attrs + ordered (/>|>) alternation — a plain `<c ([^>]*)>` attr
  // group would swallow self-closing cells and lazily eat the NEXT cell's body.
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const ref = attr('<c ' + attrs + '>', 'r');
    if (!ref) continue;
    const t = attr('<c ' + attrs + '>', 't') ?? 'n';
    const formula = body.match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1] ?? (/<f[^>]*\/>/.test(body) ? '' : undefined);
    let value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/)?.[1];
    if (t === 's' && value !== undefined && value !== '') value = sst[parseInt(value, 10)] ?? value;
    out.set(ref, { formula, value, raw: m[0] });
  }
  return out;
}

const args = process.argv.slice(2);
const refPaths: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--ref') refPaths.push(args[++i]);
const scrub = args.includes('--scrub');
const [targetPath, outPath] = args.filter((a, i) => a !== '--ref' && a !== '--scrub' && args[i - 1] !== '--ref');
if (!targetPath || !outPath || refPaths.length === 0) {
  console.error('usage: blank-return.mts <filed.xlsx> <out.xlsx> --ref <same-vintage.xlsx> [--ref ...]');
  process.exit(1);
}

(async () => {
const target = await loadReturn(targetPath);
const refs = await Promise.all(refPaths.map(loadReturn));

let cleared = 0, kept = 0, restored = 0, forceCleared = 0;
const restoredList: string[] = [];

for (const [name, path] of target.sheets) {
  let xml = await target.zip.file(path)!.async('string');
  const cells = parseCells(xml, target.sst);
  const refCellMaps: SheetCells[] = [];
  for (const r of refs) {
    const rp = r.sheets.get(name);
    if (rp) refCellMaps.push(parseCells(await r.zip.file(rp)!.async('string'), r.sst));
  }
  if (refCellMaps.length === 0) continue; // sheet absent in refs — leave untouched

  const forceSet = new Set([
    ...FORCE_CLEAR.filter(([s]) => s === name).map(([, ref]) => ref),
    ...requiredRefs(xml),
  ]);
  const edits: Array<{ ref: string; raw: string; mode: 'clear' | 'formula'; formula?: string }> = [];

  for (const [ref, info] of cells) {
    if (info.formula !== undefined) continue; // template machinery — keep
    if (info.value === undefined || info.value === '') continue;
    if (forceSet.has(ref)) {
      edits.push({ ref, raw: info.raw, mode: 'clear' });
      forceCleared++;
      continue;
    }
    const matches = refCellMaps.some((rc) => {
      const r = rc.get(ref);
      return r && r.formula === undefined && r.value === info.value;
    });
    if (matches) { kept++; continue; }
    const refFormula = refCellMaps.map((rc) => rc.get(ref)).find((r) => r?.formula !== undefined);
    if (refFormula) {
      edits.push({ ref, raw: info.raw, mode: 'formula', formula: refFormula.formula });
      restored++;
      restoredList.push(`${name}!${ref}`);
    } else {
      edits.push({ ref, raw: info.raw, mode: 'clear' });
      cleared++;
    }
  }

  for (const e of edits) {
    const style = attr(e.raw, 's');
    const sAttr = style ? ` s="${style}"` : '';
    const newCell =
      e.mode === 'clear'
        ? `<c r="${e.ref}"${sAttr}/>`
        : `<c r="${e.ref}"${sAttr}><f>${e.formula}</f></c>`;
    xml = xml.replace(new RegExp(esc(e.raw)), newCell);
  }

  if (scrub) {
    // Clear every cached formula value — stale caches carry client figures and
    // strings (headers cache "Ref: … Name: …"). Keep TA2_e-CO_* version caches
    // so vintage detection works on files whose formulas were never recalced.
    xml = xml.replace(/(<c\b[^>]*?>)(\s*<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>))\s*<v>([\s\S]*?)<\/v>/g, (all, open, f, v) =>
      /TA2_e-CO_/.test(v) ? all : open + f
    );
    target.zip.file(path, xml);
    continue;
  }
  if (edits.length) target.zip.file(path, xml);
}

if (scrub) {
  // Empty every sharedStrings entry no sheet references any more — cleared
  // client cells leave their strings (names, addresses, bank details) behind
  // in the sst pool otherwise. Indices must not shift: texts are emptied in
  // place, never removed.
  const used = new Set<number>();
  for (const [, path] of target.sheets) {
    const xml = await target.zip.file(path)!.async('string');
    for (const m of xml.matchAll(/<c\b[^>]*?\bt="s"[^>]*?>(?:<f\b[^>]*(?:\/>|>[\s\S]*?<\/f>))?<v>(\d+)<\/v>/g))
      used.add(parseInt(m[1], 10));
  }
  const sstFile = target.zip.file('xl/sharedStrings.xml');
  if (sstFile) {
    const sstXml = await sstFile.async('string');
    let i = -1, emptied = 0;
    const scrubbed = sstXml.replace(/<si>[\s\S]*?<\/si>/g, (si) => {
      i++;
      if (used.has(i)) return si;
      emptied++;
      return '<si><t/></si>';
    });
    target.zip.file('xl/sharedStrings.xml', scrubbed);
    console.log(`scrub: emptied ${emptied} unreferenced sharedStrings of ${i + 1}`);
  }
  const core = target.zip.file('docProps/core.xml');
  if (core) {
    let coreXml = await core.async('string');
    coreXml = coreXml
      .replace(/(<dc:creator>)[\s\S]*?(<\/dc:creator>)/, '$1$2')
      .replace(/(<cp:lastModifiedBy>)[\s\S]*?(<\/cp:lastModifiedBy>)/, '$1$2');
    target.zip.file('docProps/core.xml', coreXml);
  }
}

// force full recalc so restored formulas + cleared inputs recompute on open
let wb = target.wbXml;
// Excel's saved absolute path leaks the preparer's username + client folder.
if (scrub) wb = wb.replace(/<x15ac:absPath[^>]*\/>/g, '');
if (/<calcPr\b/.test(wb)) {
  wb = /fullCalcOnLoad=/.test(wb)
    ? wb.replace(/fullCalcOnLoad="0"/, 'fullCalcOnLoad="1"')
    : wb.replace(/<calcPr\b([^>]*?)\s*\/>/, '<calcPr$1 fullCalcOnLoad="1"/>');
} else {
  wb = wb.replace(/(<\/sheets>)/, '$1<calcPr fullCalcOnLoad="1"/>');
}
target.zip.file('xl/workbook.xml', wb);

fs.writeFileSync(outPath, await target.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`blanked ${targetPath} -> ${outPath}`);
console.log(`kept(template)=${kept} cleared(client)=${cleared} force-cleared=${forceCleared} formulas-restored=${restored}`);
if (restoredList.length) console.log('restored formulas at: ' + restoredList.slice(0, 30).join(', ') + (restoredList.length > 30 ? ` +${restoredList.length - 30}` : ''));
})();
