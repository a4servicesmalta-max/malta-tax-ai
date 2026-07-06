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
import { applyMapping, netProfitFromMapping, deriveSectionTotals, applyClosingEntry, TOTAL_CODE_KEYS } from '../src/mapping';
import { readTemplateCodes } from '../src/template-codes';
import { readCfrValues } from '../src/template-reader';
import { readPriorReturn } from '../src/prior-return';

const TOL = 1;

export interface OutcomeTie {
  filed: number | null;
  generated: number;
  tied: boolean | null; // null = filed value unreadable
}

export interface PairResult {
  label: string;
  accounts: number;
  proposalSource: string;
  filedInputLines: number;
  reproduced: number;
  pct: number;
  misses: Array<{ sheet: string; code: number; filed: number; generated: number | null }>;
  /**
   * Substantive outcome ties: even where sub-line placement differs from the
   * preparer, the P&L must net to the same profit (filed 7050) and the balance
   * sheet to the same total assets (filed 2299) — the "is the tax right?" test,
   * since the template computes the 35% charge from these.
   */
  outcome: { netProfit: OutcomeTie; totalAssets: OutcomeTie };
  /** Accounts the proposal left unmapped — production REFUSES to generate
   *  until the preparer maps or excludes each one, so these are flagged
   *  workload, not silent output defects. */
  unmapped: { count: number; sum: number; names: string[] };
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
  let priorYearValues: Map<string, number> | undefined;
  if (priorBuf) {
    const priorVals = (await readCfrValues(priorBuf, ['B_Sheet', 'Income'])).filter(
      (v) => v.value !== null && !v.computed && Math.abs(v.value as number) > 0.5
    );
    priorYearCodes = new Set(priorVals.map((v) => v.cfrCode));
    priorYearValues = new Map(priorVals.map((v) => [`${v.sheet}:${v.cfrCode}`, v.value as number]));
  }
  const proposal = await proposeMappingAI(etb.accounts, { templateCodes: codes, priorYearCodes, priorYearValues });
  const mapped = applyMapping(etb.accounts, { rules: proposal.rules });

  const allFiled = await readCfrValues(filedBuf, ['B_Sheet', 'Income']);
  // Section totals are typed inputs on the firm's returns — derive them
  // deterministically for rows that are non-formula inputs on this template.
  const writableTotals = new Set(
    allFiled.filter((v) => !v.computed && TOTAL_CODE_KEYS.has(`${v.sheet}:${v.cfrCode}`)).map((v) => `${v.sheet}:${v.cfrCode}`)
  );
  const templateKeys = new Set(codes.map((c) => `${c.sheet}:${c.code}`));
  // Whole-euro cells first (real returns are filed in whole euros — every
  // corpus filing carries integer inputs), so closing entry and totals use the
  // same integer arithmetic the preparer's own workings produce.
  const rounded = mapped.codeCells.map((c) => ({ ...c, amount: Math.round(c.amount) }));
  // Closing entry (3905 absorbs the year's result on pre-closing ETBs),
  // then section totals over the closed cells so 3998 includes adjusted RE.
  const closed = applyClosingEntry(rounded, templateKeys);
  const withTotals = [...closed, ...deriveSectionTotals(closed, writableTotals)];
  const byKey = new Map(withTotals.map((c) => [`${c.sheet}:${c.cfrCode}`, c.amount]));
  const filed = allFiled.filter(
    (v) => v.value !== null && !v.computed && Math.abs(v.value as number) > TOL && v.cfrCode !== 31
  );
  const positive = (await readPriorReturn(filedBuf)).convention === 'positive';

  // Substantive outcome ties (computed template totals vs our derivation).
  const filedAt = (sheet: string, code: number): number | null => {
    const v = allFiled.find((x) => x.sheet === sheet && x.cfrCode === code && x.value !== null);
    return v ? (v.value as number) : null;
  };
  const genNetProfit = netProfitFromMapping(mapped);
  const genTotalAssets = mapped.codeCells
    .filter((c) => c.sheet === 'B_Sheet' && c.cfrCode < 3000)
    .reduce((a, c) => a + c.amount, 0);
  // Outcome ties allow EUR 2: filed values are whole-euro rounded, so on large
  // balance sheets legitimate cent-accumulation exceeds the EUR 1 line tolerance.
  const tieOf = (filedV: number | null, gen: number): OutcomeTie => ({
    filed: filedV,
    generated: Math.round(gen * 100) / 100,
    tied: filedV === null ? null : Math.abs(Math.abs(filedV) - Math.abs(gen)) <= 2,
  });
  const outcome = {
    netProfit: tieOf(filedAt('Income', 7050), genNetProfit),
    totalAssets: tieOf(filedAt('B_Sheet', 2299), genTotalAssets),
  };

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
    outcome,
    unmapped: {
      count: mapped.unmappedAccounts.length,
      sum: mapped.unmappedAccounts.reduce((a, u) => a + u.balance, 0),
      names: mapped.unmappedAccounts.map((u) => `${u.code} ${u.name} (${u.balance})`),
    },
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
    if (r.unmapped.count > 0) {
      console.log(
        ` UNMAPPED (production blocks generate until preparer maps these): ${r.unmapped.count} account(s), balance sum ${r.unmapped.sum.toFixed(2)} — ${r.unmapped.names.join('; ')}`
      );
    }
    const fmtTie = (name: string, t: OutcomeTie) =>
      ` OUTCOME ${name}: filed ${t.filed ?? '—'} vs generated ${t.generated} → ${
        t.tied === null ? 'n/a' : t.tied ? 'TIED ✔' : 'DIFFERS ✘'
      }`;
    console.log(fmtTie('net profit (7050)', r.outcome.netProfit));
    console.log(fmtTie('total assets (2299)', r.outcome.totalAssets));
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
