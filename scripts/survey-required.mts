/**
 * Enumerate the CfR template's own REQUIRED-input declarations.
 * The template marks a mandatory input by a sibling formula `IF(<ref>="",re,...)`
 * (`re` = the "Required!" text on Index). We list every such <ref> per sheet,
 * with its current value — i.e. the definitive "must fill before submit" list.
 *
 * Usage: npx tsx scripts/survey-required.mts <return.xlsx> [--json out.json]
 */
import JSZip from 'jszip';
import fs from 'fs';

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : undefined;
}

const file = process.argv[2];
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
(async () => {
const zip = await JSZip.loadAsync(fs.readFileSync(file));
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
const sheets: Array<{ name: string; path: string }> = [];
for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
  const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id');
  if (name && rid && relTarget[rid]) sheets.push({ name, path: 'xl/' + relTarget[rid].replace(/^\//, '').replace(/^xl\//, '') });
}

const out: Array<{ sheet: string; ref: string; value: string; label: string }> = [];
for (const { name, path } of sheets) {
  const xml = await zip.file(path)!.async('string');
  // cell map ref -> resolved value, and label positions for context
  const val: Record<string, string> = {};
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr('<c ' + m[1] + '>', 'r');
    if (!ref) continue;
    const t = attr('<c ' + m[1] + '>', 't') ?? 'n';
    const body = m[2] ?? '';
    let v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
    if (t === 's' && v !== '') v = sst[parseInt(v, 10)] ?? v;
    val[ref] = v;
  }
  // required-marker formulas: IF(<ref>="",re...  (allow $ and spaces)
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<f[^>]*>([^<]*)<\/f>/g)) {
    const f = m[1];
    for (const rm of f.matchAll(/IF\(\s*\$?([A-Z]{1,2})\$?(\d+)\s*=\s*(?:""|&quot;&quot;)\s*,\s*re\s*[,)]/g)) {
      const ref = `${rm[1]}${rm[2]}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      // nearest label: walk left on same row
      const rowN = rm[2];
      let label = '';
      const colLetters = ['B', 'C', 'D', 'A'];
      for (const c of colLetters) {
        const lv = val[`${c}${rowN}`];
        if (lv && /[A-Za-z]{3,}/.test(lv)) { label = lv.slice(0, 70); break; }
      }
      out.push({ sheet: name, ref, value: (val[ref] ?? '').slice(0, 40), label });
    }
  }
}
for (const r of out) console.log(`${r.sheet}!${r.ref} = ${JSON.stringify(r.value)}  ${r.label ? '// ' + r.label : ''}`);
console.log(`\nTOTAL required-input cells: ${out.length}; filled: ${out.filter((r) => r.value !== '').length}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
})();
