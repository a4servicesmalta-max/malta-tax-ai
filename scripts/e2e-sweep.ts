/**
 * E2E ship-readiness sweep: run every corpus pair through the REAL server —
 * upload (parse + propose) -> generate (fill + closing entry + totals) ->
 * post-generate VERIFICATION PASS. A pair passes when generation returns 200
 * with every intended figure re-verified in the produced workbook and nothing
 * unmatched. Unmapped accounts are excluded exactly as a preparer would after
 * review (production blocks generate until each is mapped or excluded).
 *
 * Usage: npx tsx scripts/e2e-sweep.ts   (needs CLAUDE_CODE_OAUTH_TOKEN for AI mapping)
 */
process.env.TAXGEN_OPEN = '1';
process.env.DATA_DIR = process.env.DATA_DIR || require('node:os').tmpdir() + '/taxgen-e2e-sweep';
import fs from 'node:fs';
import request from 'supertest';
import { createApp } from '../src/server';

const P = 'C:/Users/user/Downloads/New/tax-corpus/pairs';
const C = 'C:/Users/user/Downloads/New/tax-corpus';
const Z = `${P}/penza/Tax Returns YA 2006 - 2024 - Penza Construction`;

const PAIRS: Array<{ name: string; etb: string; tpl: string; prior?: string }> = [
  { name: 'Fernandes Intl', etb: `${P}/Fernandes_TB_2024.xlsx`, tpl: `${C}/FernandesIntl_YA2025.xlsx`, prior: `${P}/Fernandes_TR_YA2024_prior.xlsx` },
  { name: 'EUCI', etb: `${P}/EUCI_ETB_2024.xlsx`, tpl: `${C}/EUCI_YA2025.xlsx`, prior: `${P}/EUCI_TR_YA2024_prior.xlsx` },
  { name: 'Gerard Biscuit', etb: `${P}/Gerard_ETB_2023.xlsx`, tpl: `${C}/Gerard_YA2024.xlsx`, prior: `${P}/Gerard_TR_YA2023_prior.xlsx` },
  { name: 'M Falzon', etb: `${P}/MFalzon_ETB_2022.xlsx`, tpl: `${P}/MFalzon_TR_YA2023.xlsx`, prior: `${P}/MFalzon_TR_YA2022_prior.xlsx` },
  { name: 'ESDL', etb: `${P}/ESDL_ETB_2024.xlsx`, tpl: `${P}/ESDL_TR_YA2025.xlsx`, prior: `${P}/ESDL_TR_YA2024_prior.xlsx` },
  { name: 'Freehour', etb: 'C:/Users/user/Downloads/New/freehour_2024/2024/Client Data/Updated 2024_TB/FreeHour+Limited_Trial+Balance 2024.xlsx', tpl: 'C:/Users/user/Downloads/New/freehour_2024/2024/Tax/TR 998669622 YA2025 - Freehour.xlsx' },
  { name: 'Cauchi Poultry', etb: 'C:/Users/user/Downloads/cauchi_extract/2024/Audit Working/ETB 2024 Upload File for VACEI.xlsx', tpl: 'C:/Users/user/Downloads/cauchi_extract/2024/Tax/TR 991328826 YA2025.xlsx', prior: `${P}/Cauchi_TR_YA2023_prior.xlsx` },
  { name: 'MSM IP', etb: `${P}/MSMIP_ETB_2021.xlsx`, tpl: `${P}/msmip/COR 999626529 YA2022.xlsx` },
  { name: 'Penza YA2022', etb: `${P}/Penza_ETB_2021.xlsx`, tpl: `${Z}/TR 990843210 YA2022.xlsx`, prior: `${Z}/TR 990843210 YA2021.xlsx` },
  { name: 'Penza YA2023', etb: `${P}/Penza_ETB_2022.xlsx`, tpl: `${Z}/TR 990843210 YA2023.xlsx`, prior: `${Z}/TR 990843210 YA2022.xlsx` },
  { name: 'Penza YA2024', etb: `${P}/Penza_ETB_2023.xlsx`, tpl: `${Z}/TR 990843210 YA2024.xlsx`, prior: `${Z}/TR 990843210 YA2023.xlsx` },
  { name: 'CEE Medinvest', etb: `${P}/CEE_TB_2023.xlsx`, tpl: `${P}/CEE_TR_YA2024.xlsx`, prior: `${P}/CEE_TR_YA2023_prior.xlsx` },
];

async function main() {
  const app = createApp();
  let pass = 0;
  const failures: string[] = [];
  for (const p of PAIRS) {
    try {
      let req = request(app)
        .post('/api/session')
        .attach('etb', p.etb)
        .attach('template', p.tpl);
      if (p.prior) req = req.attach('prior', p.prior);
      const s = await req;
      if (s.status !== 200) throw new Error(`session ${s.status}: ${s.body.error}`);
      const rules = s.body.proposal.rules;
      const mapped = new Set(rules.map((r: { ledgerCode: string }) => r.ledgerCode));
      const excluded = s.body.accounts
        .filter((a: { accountCode: string }) => !mapped.has(a.accountCode))
        .map((a: { accountCode: string }) => a.accountCode);
      const g = await request(app)
        .post(`/api/session/${s.body.sessionId}/generate`)
        .send({
          rules,
          answers: {},
          clientName: p.name,
          yearOfAssessment: 'E2E',
          excluded,
          priorReviewAcknowledged: true,
        });
      if (g.status !== 200) throw new Error(`generate ${g.status}: ${g.body.error}`);
      const v = g.body.verification;
      if (!v?.allWritesVerified) throw new Error('verification not green');
      console.log(
        `PASS  ${p.name.padEnd(15)} accounts=${String(s.body.accounts.length).padEnd(4)} rows=${String(v.codeRowsWritten).padEnd(4)} excluded=${excluded.length} verified=100%`
      );
      pass++;
    } catch (e) {
      console.log(`FAIL  ${p.name.padEnd(15)} ${(e as Error).message.slice(0, 140)}`);
      failures.push(p.name);
    }
  }
  console.log(`\n=== E2E SWEEP: ${pass}/${PAIRS.length} clients generate verified returns ===`);
  if (failures.length) {
    console.log('FAILED:', failures.join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
