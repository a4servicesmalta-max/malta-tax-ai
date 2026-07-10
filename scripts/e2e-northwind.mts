/**
 * E2E reproduction of the team's Northwind run (2026-07-10 bug report):
 * ETB = the team's own "ETB for tax.xlsx"; template upload = a USED filed
 * return (their real workflow — expects swap-to-blank); prior = YA2023 filed.
 * Generates through the real HTTP surface, then compares the produced
 * workbook against the team's hand-filled TR 999189205 YA2024.
 *
 * Usage: TAXGEN_OPEN=1 npx tsx scripts/e2e-northwind.mts [--ai]
 * (AI mapping is skipped by default so the run is deterministic; pass --ai
 * to exercise the mapper.)
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import JSZip from 'jszip';
import { createApp } from '../src/server';

const DIR = 'C:/Users/user/Downloads/New/tax-corpus/northwind';
const ETB = path.join(DIR, 'Northwind_ETB_for_tax.xlsx');
const TEMPLATE_UPLOAD = path.join(DIR, 'TR_999189205_YA2024_TEAM.xlsx'); // deliberately a USED return
const PRIOR = path.join(DIR, 'TR_999189205_YA2023_PRIOR.xlsx');
const TEAM = path.join(DIR, 'TR_999189205_YA2024_TEAM.xlsx');
const OUT = path.join(DIR, 'GENERATED_YA2024.xlsx');

if (!process.argv.includes('--ai')) process.env.ANTHROPIC_API_KEY = '';

async function cellValues(buffer: Buffer, wanted: Array<[string, string]>): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer);
  const wbXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const sst = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')
  );
  const relTarget: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]*)"/)?.[1];
    const t = m[0].match(/\bTarget="([^"]*)"/)?.[1];
    if (id && t) relTarget[id] = t;
  }
  const bySheet = new Map<string, Array<string>>();
  for (const [s, ref] of wanted) {
    if (!bySheet.has(s)) bySheet.set(s, []);
    bySheet.get(s)!.push(ref);
  }
  const out: Record<string, string> = {};
  for (const [sheetName, refs] of bySheet) {
    const rid = wbXml.match(new RegExp(`<sheet name="${sheetName}"[^>]*r:id="(rId\\d+)"`))?.[1];
    const target = rid && relTarget[rid];
    if (!target) continue;
    const xml = await zip.file('xl/' + target.replace(/^\//, '').replace(/^xl\//, ''))!.async('string');
    for (const ref of refs) {
      const m = xml.match(new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`));
      let v = m?.[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? m?.[2]?.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      if (m && /\bt="s"/.test(m[1]) && v !== '') v = sst[parseInt(v, 10)] ?? v;
      out[`${sheetName}!${ref}`] = v;
    }
  }
  return out;
}

(async () => {
  const app = createApp();
  console.log('1) POST /api/session (used return as template — expect swap-to-blank)');
  const s = await request(app)
    .post('/api/session')
    .attach('etb', ETB)
    .attach('template', TEMPLATE_UPLOAD)
    .attach('prior', PRIOR);
  if (s.status !== 200) throw new Error(`session failed: ${s.status} ${JSON.stringify(s.body).slice(0, 400)}`);
  const sess = s.body;
  console.log('   templateVersion:', sess.templateVersion);
  console.log('   swap warning:', sess.warnings.find((w: string) => /verified blank/i.test(w)) ?? '(NONE — BUG)');
  console.log('   priorIdentity:', JSON.stringify(sess.priorIdentity));
  console.log('   proposal source:', sess.proposal.source, 'rules:', sess.proposal.rules.length, 'accounts:', sess.accounts.length);

  // Force the TEAM's exact code picks (read off their filed YA2024) so the
  // comparison isolates engine mechanics from mapping judgment. The zero-
  // balance LOSS memo account is excluded, as a preparer would.
  const HAND: Record<string, { sheet: string; cfrCode: number }> = {
    '2100': { sheet: 'B_Sheet', cfrCode: 2100 }, // shareholder's loan
    '2200': { sheet: 'B_Sheet', cfrCode: 2200 }, // payment on account — Qormi flats
    '2105': { sheet: 'B_Sheet', cfrCode: 3554 }, // amount due to related party
    REL: { sheet: 'B_Sheet', cfrCode: 3300 }, // related party balance
    '2106': { sheet: 'B_Sheet', cfrCode: 3100 }, // accruals
    '3000': { sheet: 'B_Sheet', cfrCode: 3801 }, // share capital
    '3200': { sheet: 'B_Sheet', cfrCode: 3905 }, // retained earnings (closing)
    '8001': { sheet: 'Income', cfrCode: 6173 }, // audit fee
    '8002': { sheet: 'Income', cfrCode: 6170 }, // professional fees
    '8006': { sheet: 'Income', cfrCode: 6170 }, // tax return fee
  };
  const excluded = sess.accounts.filter((a: any) => !HAND[a.accountCode]).map((a: any) => a.accountCode);
  const rules = sess.accounts
    .filter((a: any) => HAND[a.accountCode])
    .map((a: any) => ({ ledgerCode: a.accountCode, ...HAND[a.accountCode] }));
  console.log('   excluded:', JSON.stringify(excluded));

  const answers: Record<string, number> = {
    capitalAllowancesTotal: 0,
    propertyIncomeIPA: 0,
    foreignSourceIncomeFIA: 0,
    refundDtrClaimed: 0,
    refundPassiveIncome: 0,
    refundParticipatingHolding100: 0,
    nidClaimed: 0,
    nidReferenceRate: 0,
    nidRiskCapital: 0,
    avgEmployees: 0,
    auditReportQualified: 0,
    atadStandaloneEntity: 0,
    otherDisallowedAddBack: 31331, // team's judgment: company did not trade
  };
  for (const q of sess.interview.questions) {
    if (!(q.id in answers)) answers[q.id] = q.preAnswer ?? 0;
  }
  console.log('   answers:', JSON.stringify(answers));

  console.log('2) POST computation');
  const comp = await request(app)
    .post(`/api/session/${sess.sessionId}/computation`)
    .send({ rules, answers, excluded });
  if (comp.status !== 200) throw new Error(`computation failed: ${JSON.stringify(comp.body).slice(0, 400)}`);
  console.log('   chargeable income:', comp.body.computation.chargeableIncome, 'tax:', comp.body.computation.taxCharge);

  console.log('3) POST generate');
  const gen = await request(app)
    .post(`/api/session/${sess.sessionId}/generate`)
    .send({
      rules,
      answers,
      excluded,
      clientName: 'Northwind Ltd',
      companyTin: '999189205',
      yearOfAssessment: 'YA2024',
      priorReviewAcknowledged: true,
    });
  if (gen.status !== 200) throw new Error(`generate failed: ${gen.status} ${JSON.stringify(gen.body).slice(0, 500)}`);
  console.log('   verification:', JSON.stringify(gen.body.verification));
  console.log('   declarations written:', (gen.body.declarations ?? []).length);
  for (const d of gen.body.declarations ?? []) console.log('     •', d);

  const dl = await request(app).get(`/api/session/${sess.sessionId}/return.xlsx`).buffer(true).parse(
    (res: any, cb: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }
  );
  fs.writeFileSync(OUT, dl.body);
  console.log(`4) saved ${OUT} (${dl.body.length} bytes)`);

  // ---- COMPARE vs the team's hand-filled return ----
  console.log('5) compare vs team-filled return');
  const CHECKS: Array<[string, string]> = [
    ['p1', 'AG8'], ['p1', 'L10'],
    ['TRA31', 'E166'], ['TRA63_MTA_FIA', 'O57'], ['TRA9_14', 'C153'], ['TRA29', 'C112'],
    ['TRA62_IPA', 'E86'], ['TRA62_IPA', 'G5'], ['TRA62A_IPA', 'C90'], ['TRA111', 'I93'],
    ['TRA111', 'K6'], ['TRA111', 'K11'], ['TRA111', 'N11'],
    ['TRA73', 'H120'], ['TRA73', 'H122'],
    ['p2', 'G33'], ['p2', 'G58'], ['p2', 'C75'], ['p2', 'F76'], ['p2', 'G60'],
    ['p2', 'G72'], ['p2', 'G73'], ['p2', 'G91'], ['p2', 'G94'],
    ['p5', 'H48'],
  ];
  const mine = await cellValues(fs.readFileSync(OUT), CHECKS);
  const team = await cellValues(fs.readFileSync(TEAM), CHECKS);
  let diff = 0;
  for (const [s2, ref] of CHECKS) {
    const k = `${s2}!${ref}`;
    const a = (mine[k] ?? '').trim();
    const b = (team[k] ?? '').trim();
    const same = a.toLowerCase() === b.toLowerCase();
    if (!same) diff++;
    console.log(`   ${same ? '=' : '≠'} ${k.padEnd(22)} gen=${JSON.stringify(a)} team=${JSON.stringify(b)}`);
  }
  console.log(`   declaration-cell diffs: ${diff}`);

  // Figures: compare every filed input line on B_Sheet/Income.
  const { readCfrValues } = await import('../src/template-reader');
  const teamVals = await readCfrValues(fs.readFileSync(TEAM), ['B_Sheet', 'Income']);
  const mineVals = await readCfrValues(fs.readFileSync(OUT), ['B_Sheet', 'Income']);
  const mv = new Map(mineVals.filter((v) => !v.computed && v.value != null).map((v) => [`${v.sheet}:${v.cfrCode}`, v.value as number]));
  let figDiff = 0, figSame = 0;
  for (const t of teamVals.filter((v) => !v.computed && v.value != null && Math.abs(v.value as number) > 0.5)) {
    const k = `${t.sheet}:${t.cfrCode}`;
    const m = mv.get(k);
    if (m != null && Math.abs(m - (t.value as number)) <= 1) figSame++;
    else {
      figDiff++;
      console.log(`   ≠ figure ${k.padEnd(16)} team=${t.value} gen=${m ?? '(empty)'}`);
    }
  }
  const extra = [...mv.entries()].filter(([k, v]) => Math.abs(v) > 0.5 && !teamVals.some((t) => `${t.sheet}:${t.cfrCode}` === k && t.value != null && Math.abs((t.value as number) - v) <= 1));
  for (const [k, v] of extra) console.log(`   + gen-only figure ${k.padEnd(16)} gen=${v}`);
  console.log(`   figures: ${figSame} match, ${figDiff} differ, ${extra.length} gen-only`);
  console.log('DONE');
})().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});
