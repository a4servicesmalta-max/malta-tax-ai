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
});
