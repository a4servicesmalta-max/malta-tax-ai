/**
 * Diff every typed (non-formula, non-empty) cell between a reference return
 * and a generated one — the complete "what would a preparer still have to
 * type" list. Values are resolved (sharedStrings/inline) and compared
 * case-insensitively; numbers within ±1 are equal.
 *
 * Usage: npx tsx scripts/diff-returns.mts <team.xlsx> <generated.xlsx>
 */
import JSZip from 'jszip';
import fs from 'fs';

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

async function load(path: string) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path));
  const wbXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const sst = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')
  );
  const relTarget: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id'), t = attr(m[0], 'Target');
    if (id && t) relTarget[id] = t;
  }
  const sheets = new Map<string, Map<string, string>>(); // sheet -> ref -> typed value
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id');
    if (!name || !rid || !relTarget[rid]) continue;
    const xml = await zip.file('xl/' + relTarget[rid].replace(/^\//, '').replace(/^xl\//, ''))!.async('string');
    const cells = new Map<string, string>();
    for (const cm of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? '', body = cm[2] ?? '';
      if (/<f[\s>]/.test(body)) continue; // formula — template machinery
      const ref = attr('<c ' + attrs + '>', 'r');
      if (!ref) continue;
      const t = attr('<c ' + attrs + '>', 't') ?? 'n';
      let v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      if (v === '') continue;
      if (t === 's') v = sst[parseInt(v, 10)] ?? v;
      cells.set(ref, String(v).trim());
    }
    sheets.set(name, cells);
  }
  return sheets;
}

const eq = (a: string, b: string) => {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const na = Number(a), nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) <= 1;
};

(async () => {
  const [teamPath, genPath] = process.argv.slice(2);
  const team = await load(teamPath);
  const gen = await load(genPath);
  let missing = 0, differs = 0, extra = 0;
  for (const [sheet, tcells] of team) {
    const gcells = gen.get(sheet) ?? new Map<string, string>();
    for (const [ref, tv] of tcells) {
      const gv = gcells.get(ref);
      if (gv === undefined) {
        missing++;
        console.log(`MISSING ${sheet}!${ref} team=${JSON.stringify(tv.slice(0, 50))}`);
      } else if (!eq(tv, gv)) {
        differs++;
        console.log(`DIFFERS ${sheet}!${ref} team=${JSON.stringify(tv.slice(0, 50))} gen=${JSON.stringify(gv.slice(0, 50))}`);
      }
    }
    for (const [ref, gv] of gcells) {
      if (!tcells.has(ref)) {
        extra++;
        console.log(`EXTRA   ${sheet}!${ref} gen=${JSON.stringify(gv.slice(0, 50))}`);
      }
    }
  }
  console.log(`\nSUMMARY: missing=${missing} differs=${differs} gen-extra=${extra}`);
})();
