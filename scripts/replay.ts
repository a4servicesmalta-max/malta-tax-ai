/**
 * Corpus replay: how well does the generator reproduce an actually-filed return?
 * Usage: npm run replay -- --etb fixtures/etb/<client>/<year>.xlsx --filed "fixtures/returns/<client>/<file>.xlsx" [--prior "<prior file>"]
 * Accuracy = share of the filed return's non-null code values reproduced within €1
 * by mapping the ETB with the (heuristic/prior-biased) proposal.
 */
import fs from 'node:fs';
import { parseEtb } from '../src/etb-parser';
import { proposeMapping } from '../src/mapping';
import { applyMapping } from '../src/mapping';
import { readPriorReturn } from '../src/prior-return';
import { readCfrValues } from '../src/template-reader';
import type { EtbAccount, MappingProfile } from '../src/domain';

const TOL = 1;

export interface ReplayResult {
  total: number;
  matched: number;
  diffs: Array<{ sheet: string; cfrCode: number; filed: number; generated: number | null }>;
}

export async function replayAccuracy(
  filedReturn: Buffer,
  etb: EtbAccount[],
  profile: MappingProfile
): Promise<ReplayResult> {
  // Compare preparer INPUT rows only: template-computed subtotals (formula
  // cells), empty/zero rows and the Y/A marker row (code 31) are not figures
  // the generator is supposed to produce.
  const filed = (await readCfrValues(filedReturn, ['B_Sheet', 'Income'])).filter(
    (v) => v.value !== null && !v.computed && Math.abs(v.value) > TOL && v.cfrCode !== 31
  );
  // Filed returns are commonly all-positive (the template computes the signs);
  // compare magnitudes under that convention, same as priorYearCrossCheck.
  const positive = (await readPriorReturn(filedReturn)).convention === 'positive';
  const mapped = applyMapping(etb, profile);
  const byKey = new Map(mapped.codeCells.map((c) => [`${c.sheet}:${c.cfrCode}`, c.amount]));
  let matched = 0;
  const diffs: ReplayResult['diffs'] = [];
  for (const f of filed) {
    const gen = byKey.get(`${f.sheet}:${f.cfrCode}`) ?? null;
    const filedV = positive ? Math.abs(f.value as number) : (f.value as number);
    const genV = gen !== null && positive ? Math.abs(gen) : gen;
    if (genV !== null && Math.abs(genV - filedV) <= TOL) matched++;
    else diffs.push({ sheet: f.sheet, cfrCode: f.cfrCode, filed: f.value as number, generated: gen });
  }
  return { total: filed.length, matched, diffs };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const etbPath = get('etb');
  const filedPath = get('filed');
  if (!etbPath || !filedPath) {
    console.error('Usage: npm run replay -- --etb <etb.xlsx> --filed <filed-return.xlsx> [--prior <prior.xlsx>]');
    process.exit(1);
  }
  const etb = parseEtb(fs.readFileSync(etbPath));
  let priorCodes: Set<number> | undefined;
  const priorPath = get('prior');
  if (priorPath) priorCodes = (await readPriorReturn(fs.readFileSync(priorPath))).codes;
  const proposal = proposeMapping(etb.accounts, { priorYearCodes: priorCodes });
  const r = await replayAccuracy(fs.readFileSync(filedPath), etb.accounts, { rules: proposal.rules });
  console.log(`Replay: ${r.matched}/${r.total} filed code values reproduced (${((100 * r.matched) / Math.max(1, r.total)).toFixed(1)}%)`);
  for (const d of r.diffs)
    console.log(`  MISS ${d.sheet} code ${d.cfrCode}: filed ${d.filed} vs generated ${d.generated ?? '—'}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
