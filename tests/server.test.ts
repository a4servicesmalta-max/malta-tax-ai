import { describe, it, expect } from 'vitest';
import request from 'supertest';
import JSZip from 'jszip';
import { createApp } from '../src/server';
import { syntheticCfrWorkbook, syntheticEtbXlsx } from './helpers/synthetic';

async function fixtures() {
  const etb = syntheticEtbXlsx([
    ['Code', 'Account Name', 'Debit', 'Credit'],
    ['1200', 'Bank current account', 5000, null],
    ['4000', 'Sales', null, 80000],
  ]);
  const template = await syntheticCfrWorkbook({
    bSheet: [{ row: 10, code: 2150 }],
    income: [{ row: 5, code: 5000 }],
  });
  return { etb, template };
}

describe('server', () => {
  it('creates a session from uploads and returns proposal + interview', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const res = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.proposal.rules.length).toBeGreaterThan(0);
    expect(res.body.interview.questions.length).toBeGreaterThan(0);
  });

  // A MulterError (here: an unexpected multipart field) is thrown by the
  // upload.fields middleware before any route try/catch. The error-handling
  // middleware must translate it into a JSON 400, not let it fall through to
  // Express's default plain-text 500.
  it('translates a multer error (unexpected field) into a JSON 400', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const res = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx')
      .attach('bogus', Buffer.from('x'), 'bogus.bin'); // field multer does not expect
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('serves the tax computation working paper before generation', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    const rules = [
      { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
      { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
    ];
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/computation`)
      .send({ rules, answers: { depreciationAddBack: 3000, lossesBroughtForward: 500 }, excluded: [] });
    expect(res.status).toBe(200);
    const c = res.body.computation;
    // Sales −80000 (Cr) → net profit 80000; +3000 add-back − 500 losses → 82500 @35%
    expect(c.netProfitPerAccounts).toBe(80000);
    expect(c.adjustedProfit).toBe(83000);
    expect(c.lossesUtilised).toBe(500);
    expect(c.chargeableIncome).toBe(82500);
    expect(c.taxCharge).toBe(28875);
  });

  it('refuses to serve a computation while accounts are unmapped', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/computation`)
      .send({ rules: [], answers: {}, excluded: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unmapped/i);
  });

  it('refuses to generate while accounts are unmapped', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({ rules: [], answers: {}, clientName: 'X', yearOfAssessment: 'YA2026', excluded: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unmapped/i);
  });

  it('generates and serves the filled return and summary', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    const gen = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        ],
        answers: { depreciationAddBack: 0 },
        clientName: 'Test Client Ltd',
        yearOfAssessment: 'YA2026',
        excluded: [],
      });
    expect(gen.status).toBe(200);
    const xlsx = await request(app)
      .get(`/api/session/${s.body.sessionId}/return.xlsx`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    const zip = await JSZip.loadAsync(xlsx.body);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<c r="E10"><v>5000</v></c>');
    const summary = await request(app).get(`/api/session/${s.body.sessionId}/summary.html`);
    expect(summary.status).toBe(200);
    expect(summary.text).toContain('Test Client Ltd');
  });

  it('blocks generation until prior-return error findings are acknowledged', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const badPrior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 12, code: 3801, value: -3000 }, // does not balance -> error finding
      ],
      income: [],
    });
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx')
      .attach('prior', badPrior, 'prior.xlsx');
    expect(s.body.priorReview.findings.length).toBeGreaterThan(0);
    const body = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      ],
      answers: {}, clientName: 'X', yearOfAssessment: 'YA2026', excluded: [],
    };
    const blocked = await request(app).post(`/api/session/${s.body.sessionId}/generate`).send(body);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/prior-year return review/i);
    const ok = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({ ...body, priorReviewAcknowledged: true });
    expect(ok.status).toBe(200);
  });

  // The gate keys on error-severity findings, not on the mere presence of a
  // prior return. A prior return that produces no error-severity findings must
  // generate without any acknowledgment. (reviewPriorReturn emits errors only,
  // so a clean signed prior return yields zero findings.)
  it('does not block generation when the prior return has no error findings', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const cleanPrior = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 4000 },
        { row: 12, code: 3801, value: -4000 }, // balances -> no error finding
      ],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx')
      .attach('prior', cleanPrior, 'prior.xlsx');
    expect(s.body.priorReview.findings.filter((f: { severity: string }) => f.severity === 'error')).toEqual([]);
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        ],
        answers: {}, clientName: 'X', yearOfAssessment: 'YA2026', excluded: [],
      }); // no priorReviewAcknowledged
    expect(res.status).toBe(200);
  });

  it('generates without a prior return and without acknowledgment', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    expect(s.body.priorReview).toBeNull();
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        ],
        answers: {}, clientName: 'X', yearOfAssessment: 'YA2026', excluded: [],
      });
    expect(res.status).toBe(200);
  });

  it('omits an excluded account from the fill without triggering the unmapped-400', async () => {
    const app = createApp();
    // Third account (9999) is deliberately left unmapped but will be excluded.
    const etb = syntheticEtbXlsx([
      ['Code', 'Account Name', 'Debit', 'Credit'],
      ['1200', 'Bank current account', 5000, null],
      ['4000', 'Sales', null, 80000],
      ['9999', 'Mystery suspense', 10, null],
    ]);
    const template = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150 }],
      income: [{ row: 5, code: 5000 }],
    });
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    expect(s.body.accounts).toHaveLength(3);
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        ],
        answers: {},
        clientName: 'X',
        yearOfAssessment: 'YA2026',
        excluded: ['9999'], // excluded, so not unmapped
      });
    expect(res.status).toBe(200);
    // The excluded account must not appear as mapping provenance in the summary.
    const summary = await request(app).get(`/api/session/${s.body.sessionId}/summary.html`);
    expect(summary.text).not.toContain('Mystery suspense');
  });

  // The FS tie-check's totalAssets proxy must count only asset-class codes
  // (sub-3000) with signs netting — a positive amount on an equity code (3801)
  // must NOT be counted as an asset.
  it('excludes equity-code amounts from the asset-class totalAssets proxy', async () => {
    const app = createApp();
    // Bank (asset, code 2150, +5000) and a share-capital-like Dr balance we
    // deliberately map to equity code 3801 (+2000). Asset-only total = 5000.
    const etb = syntheticEtbXlsx([
      ['Code', 'Account Name', 'Debit', 'Credit'],
      ['1200', 'Bank current account', 5000, null],
      ['3000', 'Equity clearing (misclassified Dr)', 2000, null],
      ['4000', 'Sales', null, 80000],
    ]);
    const template = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150 }, { row: 12, code: 3801 }],
      income: [{ row: 5, code: 5000 }],
    });
    // FS declares total assets = 5000 (the asset-only sum). If the server wrongly
    // added the +2000 on equity code 3801, the ETB-derived total would be 7000
    // and the tie would fail.
    const fs = syntheticEtbXlsx([
      ['Statement of financial position', null],
      ['Total assets', 5000],
    ]);
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('fs', fs, 'fs.xlsx')
      .attach('template', template, 'template.xlsx');
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '3000', cfrCode: 3801, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        ],
        answers: {}, clientName: 'X', yearOfAssessment: 'YA2026', excluded: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.tie.checks.totalAssets).toBe('tied');
    expect(res.body.tie.issues.some((i: string) => /total assets do not tie/i.test(i))).toBe(false);
  });
});
