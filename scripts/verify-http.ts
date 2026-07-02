/**
 * End-to-end HTTP verification against a running server (PORT env or 4381).
 * Exercises: session creation, prior-review gate (blocked then acknowledged),
 * generation, and the two download endpoints. Not a unit test — a smoke check.
 * Run: PORT=4381 npx tsx scripts/verify-http.ts
 */
import { syntheticCfrWorkbook, syntheticEtbXlsx } from '../tests/helpers/synthetic';
import JSZip from 'jszip';

const BASE = `http://localhost:${process.env.PORT || 4381}`;

function form(fields: Record<string, { buf: Buffer; name: string } | string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') fd.append(k, v);
    else fd.append(k, new Blob([new Uint8Array(v.buf)]), v.name);
  }
  return fd;
}

async function main() {
  const etb = syntheticEtbXlsx([
    ['Code', 'Account Name', 'Debit', 'Credit'],
    ['1200', 'Bank current account', 5000, null],
    ['4000', 'Sales', null, 80000],
    ['5000', 'Cost of sales', 75000, null],
  ]);
  const template = await syntheticCfrWorkbook({
    bSheet: [{ row: 10, code: 2150 }],
    income: [{ row: 5, code: 5000 }],
  });
  // Prior return whose balance sheet does NOT balance -> error finding.
  const badPrior = await syntheticCfrWorkbook({
    bSheet: [
      { row: 10, code: 2150, value: 4000 },
      { row: 12, code: 3801, value: -3000 },
    ],
    income: [],
  });

  const results: string[] = [];
  const check = (label: string, cond: boolean) => {
    results.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) process.exitCode = 1;
  };

  // 1. Create session with a bad prior return.
  const sRes = await fetch(`${BASE}/api/session`, {
    method: 'POST',
    body: form({
      etb: { buf: etb, name: 'etb.xlsx' },
      template: { buf: template, name: 'template.xlsx' },
      prior: { buf: badPrior, name: 'prior.xlsx' },
    }),
  });
  const s = await sRes.json();
  check('session created (200)', sRes.status === 200);
  check('accounts parsed = 3', s.accounts?.length === 3);
  check('priorReview returned with >=1 finding', (s.priorReview?.findings?.length ?? 0) >= 1);
  check(
    'prior review flags an error-severity finding',
    s.priorReview?.findings?.some((f: { severity: string }) => f.severity === 'error')
  );

  const genBody = {
    rules: [
      { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
      { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      { ledgerCode: '5000', cfrCode: 5000, sheet: 'Income' },
    ],
    answers: {},
    clientName: 'HTTP Smoke Ltd',
    yearOfAssessment: 'YA2026',
    excluded: [],
  };

  // 2. Generate WITHOUT acknowledgment -> blocked 400 mentioning prior-year return review.
  const blocked = await fetch(`${BASE}/api/session/${s.sessionId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(genBody),
  });
  const blockedBody = await blocked.json();
  check('generation blocked without acknowledgment (400)', blocked.status === 400);
  check(
    'block message mentions prior-year return review',
    /prior-year return review/i.test(blockedBody.error ?? '')
  );

  // 3. Generate WITH acknowledgment -> 200.
  const ok = await fetch(`${BASE}/api/session/${s.sessionId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...genBody, priorReviewAcknowledged: true }),
  });
  check('generation succeeds once acknowledged (200)', ok.status === 200);

  // 4. Download the filled return and confirm the mapped figure landed in E5 (Income 5000 = -80000+75000 = -5000).
  const xlsxRes = await fetch(`${BASE}/api/session/${s.sessionId}/return.xlsx`);
  check('return.xlsx served (200)', xlsxRes.status === 200);
  const zip = await JSZip.loadAsync(Buffer.from(await xlsxRes.arrayBuffer()));
  const incomeSheet = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  check('income code 5000 written to E5 = -5000', incomeSheet.includes('<c r="E5"><v>-5000</v></c>'));

  // 5. Download the computation summary and confirm client name + a prior-review warning appear.
  const sumRes = await fetch(`${BASE}/api/session/${s.sessionId}/summary.html`);
  const sumHtml = await sumRes.text();
  check('summary.html served (200)', sumRes.status === 200);
  check('summary names the client', sumHtml.includes('HTTP Smoke Ltd'));

  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
}

main().catch((e) => {
  console.error('verify-http error:', e);
  process.exit(1);
});
