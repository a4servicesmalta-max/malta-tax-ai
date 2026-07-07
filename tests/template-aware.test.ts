import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server';
import { syntheticCfrWorkbook, syntheticEtbXlsx } from './helpers/synthetic';
import { readTemplateCodes } from '../src/template-codes';
import { proposeMapping } from '../src/mapping';
import { proposeMappingAI } from '../src/ai-mapper';
import { extractFiguresFromText, extractFsFiguresAny } from '../src/fs-tie-check';

const ETB = syntheticEtbXlsx([
  ['Code', 'Account Name', 'Debit', 'Credit'],
  ['1200', 'Bank current account', 5000, null],
  ['4000', 'Sales', null, 80000],
]);

describe('template-aware mapping', () => {
  it('reads the code rows (sheet, code) from a template workbook', async () => {
    const tpl = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150 }],
      income: [{ row: 5, code: 5000 }],
    });
    const codes = readTemplateCodes(tpl);
    expect(codes).toContainEqual(expect.objectContaining({ sheet: 'B_Sheet', code: 2150 }));
    expect(codes).toContainEqual(expect.objectContaining({ sheet: 'Income', code: 5000 }));
  });

  it('heuristic proposals DROP codes that are not on the template', () => {
    const accounts = [
      { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: null },
      { accountCode: '7000', accountName: 'Depreciation charge', cyBalance: 2000, pyBalance: null }, // heuristic → 6300, not on template
    ];
    const { rules } = proposeMapping(accounts, {
      templateCodes: [
        { sheet: 'B_Sheet', code: 2150, label: 'Cash at bank' },
        { sheet: 'Income', code: 5000, label: 'Sales' },
      ],
    });
    expect(rules.map((r) => r.ledgerCode)).toEqual(['1200']); // depreciation dropped → visibly unmapped
  });

  it('AI proposals are filtered to template codes, and the prompt lists them', async () => {
    const fake = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            rules: [
              { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet', confidence: 0.9 }, // valid
              { ledgerCode: '4000', cfrCode: 9999, sheet: 'Income', confidence: 0.9 }, // hallucinated
            ],
          }),
        },
      ],
    });
    const res = await proposeMappingAI(
      [
        { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: null },
        { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: null },
      ],
      {
        templateCodes: [
          { sheet: 'B_Sheet', code: 2150, label: 'Cash at bank and in hand' },
          { sheet: 'Income', code: 5099, label: 'Total sales of goods and services' },
        ],
      },
      { apiKey: 'test', createMessage: fake }
    );
    expect(res.rules).toEqual([{ ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet', confidence: 0.9 }]);
    const prompt = (fake.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content;
    expect(prompt).toContain('VALID CODES');
    expect(prompt).toContain('5099 = Total sales of goods and services');
  });

  it('rejects a template with no code rows at upload (wrong file)', async () => {
    const res = await request(createApp())
      .post('/api/session')
      .attach('etb', ETB, 'etb.xlsx')
      .attach('template', ETB, 'not-a-template.xlsx'); // an ETB is not a CfR template
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not look like a CfR e-return/i);
  });

  it('session returns templateCodes; generate 400s on a code not on the template', async () => {
    const app = createApp();
    const tpl = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150 }],
      income: [{ row: 5, code: 5000 }],
    });
    const s = await request(app)
      .post('/api/session')
      .attach('etb', ETB, 'etb.xlsx')
      .attach('template', tpl, 'template.xlsx');
    expect(s.status).toBe(200);
    expect(s.body.templateCodes.length).toBe(2);

    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 6300, sheet: 'Income' }, // not a line on this template
        ],
        answers: {},
        clientName: 'X',
        yearOfAssessment: 'YA2026',
        excluded: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not lines on this template/i);
    expect(res.body.error).toContain('6300');
  });

  it('generate returns a verification summary confirming every write landed', async () => {
    const app = createApp();
    const tpl = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150 }],
      income: [{ row: 5, code: 5000 }],
    });
    const s = await request(app)
      .post('/api/session')
      .attach('etb', ETB, 'etb.xlsx')
      .attach('template', tpl, 'template.xlsx');
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
        excluded: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.verification).toEqual({
      accountsIncluded: 2,
      codeRowsWritten: 2,
      staleValuesCleared: 0,
      allWritesVerified: true,
    });
  });
});

describe('FS any-format extraction', () => {
  it('extracts figures from plain text lines (PDF/DOCX text path)', () => {
    const text = [
      'STATEMENT OF COMPREHENSIVE INCOME',
      'Revenue 12 1,240,000',
      'Profit for the year 5 182,400',
      'STATEMENT OF FINANCIAL POSITION',
      'Total assets 3,500,250.75',
    ].join('\n');
    const f = extractFiguresFromText(text);
    expect(f.netProfit).toBe(182400);
    expect(f.totalAssets).toBe(3500250.75);
  });

  it('handles bracketed losses in text', () => {
    const f = extractFiguresFromText('Loss for the year (25,300)');
    expect(f.netProfit).toBe(-25300);
  });

  it('CSV goes through the spreadsheet path', async () => {
    const csv = Buffer.from('Label,Amount\nProfit for the year,182400\nTotal assets,3500000\n');
    const { figures, note } = await extractFsFiguresAny(csv, 'fs.csv');
    expect(figures.netProfit).toBe(182400);
    expect(figures.totalAssets).toBe(3500000);
    expect(note).toBeNull();
  });

  it('an unreadable file degrades to a plain-English note, never a throw', async () => {
    const { figures, note } = await extractFsFiguresAny(Buffer.from('%PDF-garbage'), 'broken.pdf');
    expect(figures).toEqual({ netProfit: null, totalAssets: null });
    expect(note).toMatch(/could not be read/i);
  });
});
