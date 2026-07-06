/**
 * Template-aware corpus validation: for each ETB + filed-return pair, run the
 * REAL pipeline (read the filed return's own code rows, AI-map the ETB against
 * them, apply) and measure how many of the filed return's preparer-input lines
 * the engine reproduces within €1. This is the accuracy oracle for "every
 * return correct" — it scales to the whole corpus the moment more pairs exist.
 *
 * Usage:
 *   npx tsx scripts/validate-corpus.ts --pair <etb.xlsx> <filed.xlsx> [--pair ...]
 *   npx tsx scripts/validate-corpus.ts --dir <folder-with-pairs.json>
 */
import fs from 'node:fs';
import { parseEtb } from '../src/etb-parser';
import { proposeMappingAI } from '../src/ai-mapper';
import { applyMapping } from '../src/mapping';
import { readTemplateCodes } from '../src/template-codes';
import { readCfrValues } from '../src/template-reader';
import { readPriorReturn } from '../src/prior-return';

const TOL = 1;

export interface PairResult {
  label: string;
  accounts: number;
  proposalSource: string;
  filedInputLines: number;
  reproduced: number;
  pct: number;
  misses: Array<{ sheet: string; code: number; filed: number; generated: number | null }>;
}

export async function validatePair(
  etbBuf: Buffer,
  filedBuf: Buffer,
  label: string,
  priorBuf?: Buffer
): Promise<PairResult> {
  const codes = readTemplateCodes(filedBuf);
  const etb = parseEtb(etbBuf);
  // Production behavior for repeat clients: prime with the codes populated on
  // the client's prior-year return.
  let priorYearCodes: Set<number> | undefined;
  if (priorBuf) {
    const priorVals = (await readCfrValues(priorBuf, ['B_Sheet', 'Income'])).filter(
      (v) => v.value !== null && !v.computed && Math.abs(v.value as number) > 0.5
    );
    priorYearCodes = new Set(priorVals.map((v) => v.cfrCode));
  }
  const proposal = await proposeMappingAI(etb.accounts, { templateCodes: codes, priorYearCodes });
  const mapped = applyMapping(etb.accounts, { rules: proposal.rules });
  const byKey = new Map(mapped.codeCells.map((c) => [`${c.sheet}:${c.cfrCode}`, c.amount]));

  const filed = (await readCfrValues(filedBuf, ['B_Sheet', 'Income'])).filter(
    (v) => v.value !== null && !v.computed && Math.abs(v.value as number) > TOL && v.cfrCode !== 31
  );
  const positive = (await readPriorReturn(filedBuf)).convention === 'positive';

  let reproduced = 0;
  const misses: PairResult['misses'] = [];
  for (const f of filed) {
    const gen = byKey.get(`${f.sheet}:${f.cfrCode}`) ?? null;
    const fv = positive ? Math.abs(f.value as number) : (f.value as number);
    const gv = gen !== null && positive ? Math.abs(gen) : gen;
    if (gv !== null && Math.abs(gv - fv) <= TOL) reproduced++;
    else misses.push({ sheet: f.sheet, code: f.cfrCode, filed: f.value as number, generated: gen });
  }
  return {
    label,
    accounts: etb.accounts.length,
    proposalSource: proposal.source,
    filedInputLines: filed.length,
    reproduced,
    pct: filed.length ? Math.round((1000 * reproduced) / filed.length) / 10 : 0,
    misses,
  };
}

async function main() {
  const args = process.argv.slice(2);
  // --pair <etb> <filed> [--prior <priorReturn>]  (prior applies to the preceding pair)
  const pairs: Array<[string, string, string, string | null]> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pair') {
      const etb = args[i + 1];
      const filed = args[i + 2];
      pairs.push([etb, filed, (filed.split(/[\\/]/).pop() || filed).replace(/\.xlsx$/i, ''), null]);
      i += 2;
    } else if (args[i] === '--prior' && pairs.length) {
      pairs[pairs.length - 1][3] = args[i + 1];
      i += 1;
    }
  }
  if (!pairs.length) {
    console.error('Usage: npx tsx scripts/validate-corpus.ts --pair <etb.xlsx> <filed.xlsx> [--pair ...]');
    process.exit(1);
  }
  let totLines = 0;
  let totRepro = 0;
  for (const [etb, filed, label, prior] of pairs) {
    const r = await validatePair(
      fs.readFileSync(etb),
      fs.readFileSync(filed),
      label + (prior ? ' [PY-primed]' : ''),
      prior ? fs.readFileSync(prior) : undefined
    );
    totLines += r.filedInputLines;
    totRepro += r.reproduced;
    console.log(
      `\n=== ${r.label} ===\n accounts=${r.accounts} proposal=${r.proposalSource} | reproduced ${r.reproduced}/${r.filedInputLines} filed input lines (${r.pct}%)`
    );
    for (const m of r.misses.slice(0, 12)) {
      console.log(`   MISS ${m.sheet}/${m.code}: filed ${m.filed} vs generated ${m.generated ?? '—'}`);
    }
    if (r.misses.length > 12) console.log(`   … +${r.misses.length - 12} more`);
  }
  console.log(
    `\n=== CORPUS TOTAL: ${totRepro}/${totLines} filed input lines reproduced (${
      totLines ? Math.round((1000 * totRepro) / totLines) / 10 : 0
    }%) ===`
  );
}

if (require.main === module) main().catch((e) => (console.error(e), process.exit(1)));
