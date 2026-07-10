/**
 * Survey a CfR return's INPUT SURFACE via cell-protection styles.
 * CfR e-return sheets are protected; data-entry cells carry an unlocked style.
 * Dumps: per-sheet unlocked constant cells (the preparer-typed values),
 * every "ATTACHMENT COMPLETE" flag row and its value, and defined-name masters.
 *
 * Usage: npx tsx scripts/survey-inputs.mts <return.xlsx> [--sheet NAME] [--all]
 */
import JSZip from 'jszip';
import fs from 'fs';

const file = process.argv[2];
const only = process.argv.includes('--sheet') ? process.argv[process.argv.indexOf('--sheet') + 1] : null;
const showAll = process.argv.includes('--all');

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : undefined;
}

(async () => {
const zip = await JSZip.loadAsync(fs.readFileSync(file));
const wbXml = await zip.file('xl/workbook.xml')!.async('string');
const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
const stylesXml = await zip.file('xl/styles.xml')!.async('string');
const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';

// shared strings
const sst: string[] = [];
for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
  sst.push(texts.join(''));
}

// unlocked style indices from cellXfs
const cellXfs = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
const unlocked = new Set<number>();
let xfIdx = 0;
for (const m of cellXfs.matchAll(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)) {
  if (/<protection[^>]*locked="0"/.test(m[0])) unlocked.add(xfIdx);
  xfIdx++;
}
console.log(`styles: ${xfIdx} cellXfs, ${unlocked.size} unlocked`);

// sheet name -> path
const relTarget: Record<string, string> = {};
for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
  const id = attr(m[0], 'Id'), t = attr(m[0], 'Target');
  if (id && t) relTarget[id] = t;
}
const sheets: Array<{ name: string; path: string }> = [];
for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
  const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id');
  if (name && rid && relTarget[rid]) sheets.push({ name, path: 'xl/' + relTarget[rid].replace(/^\//, '').replace(/^xl\//, '') });
}
console.log(`sheets: ${sheets.length}`);

let totalInputs = 0;
for (const { name, path } of sheets) {
  if (only && name !== only) continue;
  const xml = await zip.file(path)!.async('string');
  // constant cells (no formula) with a value
  const inputs: Array<{ ref: string; v: string; t: string }> = [];
  const flags: Array<string> = [];
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const ref = attr('<c ' + attrs + '>', 'r');
    if (!ref) continue;
    const s = parseInt(attr('<c ' + attrs + '>', 's') ?? '0', 10);
    const t = attr('<c ' + attrs + '>', 't') ?? 'n';
    const hasFormula = /<f[\s>]/.test(body);
    const vRaw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? (body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
    let v = vRaw;
    if (t === 's' && vRaw !== '') v = sst[parseInt(vRaw, 10)] ?? vRaw;
    if (/ATTACHMENT\s+COMPLETE/i.test(v)) flags.push(`${ref} LABEL ${JSON.stringify(v.slice(0, 50))}`);
    if (hasFormula) continue;
    if (v === '') continue;
    if (unlocked.has(s)) {
      inputs.push({ ref, v: v.slice(0, 40), t });
      totalInputs++;
    }
  }
  if (inputs.length || flags.length) {
    console.log(`\n== ${name} (${inputs.length} unlocked constants)`);
    if (flags.length) console.log('  FLAGS: ' + flags.join(' | '));
    const show = showAll || only ? inputs : inputs.slice(0, 8);
    for (const i of show) console.log(`  ${i.ref} [${i.t}] ${JSON.stringify(i.v)}`);
    if (!showAll && !only && inputs.length > 8) console.log(`  ... +${inputs.length - 8} more`);
  }
}
console.log(`\nTOTAL unlocked constant (typed-input) cells: ${totalInputs}`);
})();
