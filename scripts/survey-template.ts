/**
 * Survey a real CfR workbook: list all sheet names, and for key sheets dump the
 * (row, CfR code, current value) triples. Use the output to populate ANCHORS in
 * src/template-map.ts for interview-fill targets (losses b/f, TRA totals, etc.).
 *
 * Usage: npm run survey -- "fixtures/returns/<client>/<file>.xlsx" [SheetName ...]
 *
 * Note: readCfrValues throws on a sheet name that doesn't exist in the workbook.
 * Default targets are derived from listSheetNames() so they are always valid;
 * explicit sheet names passed on the command line are still user-controlled, so
 * the read is wrapped in try/catch to report a clean error instead of a stack trace.
 */
import fs from 'node:fs';
import { listSheetNames, readCfrValues } from '../src/template-reader';

async function main() {
  const [file, ...sheets] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: npm run survey -- <workbook.xlsx> [SheetName ...]');
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const names = await listSheetNames(buf);
  console.log(`Sheets (${names.length}):`);
  for (const n of names) console.log('  ' + n);
  const targets = sheets.length ? sheets : names.filter((n) => /b_sheet|income|tra|^p\d/i.test(n));
  console.log(`\nCode/value rows for: ${targets.join(', ')}`);
  try {
    const vals = await readCfrValues(buf, targets);
    for (const v of vals) console.log(`${v.sheet}\trow ${v.row}\tcode ${v.cfrCode}\tvalue ${v.value ?? '—'}`);
  } catch (e) {
    console.error(`Could not read one or more requested sheets: ${(e as Error).message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
