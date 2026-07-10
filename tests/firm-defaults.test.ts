import { describe, it, expect } from 'vitest';
import { declarationCells, interestExpenseTotal } from '../src/firm-defaults';
import { applyClosingEntry } from '../src/mapping';

const req = (...keys: string[]) => new Set(keys);

describe('declarationCells', () => {
  const sheets = new Set(['p1', 'p2', 'p5', 'TRA31', 'TRA111']);

  it('writes identity to the p1 master cells (numeric TIN, uppercased name)', () => {
    const { cells } = declarationCells({
      required: req(),
      sheets,
      companyName: 'Northwind Ltd',
      companyTin: '999189205',
      interestExpense: 0,
      answers: {},
    });
    expect(cells).toContainEqual({ sheet: 'p1', ref: 'AG8', value: 999189205 });
    expect(cells).toContainEqual({ sheet: 'p1', ref: 'L10', value: 'NORTHWIND LTD' });
  });

  it('writes standing declarations only where the template marks the ref Required', () => {
    const { cells } = declarationCells({
      required: req('TRA31!E166', 'p2!G58'),
      sheets,
      interestExpense: 0,
      answers: {},
    });
    expect(cells).toContainEqual({ sheet: 'TRA31', ref: 'E166', value: 'Yes' });
    expect(cells).toContainEqual({ sheet: 'p2', ref: 'G58', value: 'Malta' });
    // p5!H48 not in this template's required set — never written blind
    expect(cells.find((c) => c.sheet === 'p5')).toBeUndefined();
  });

  it('fills TRA111 ATAD answers with the deterministic EBC amount under €3M', () => {
    const { cells } = declarationCells({ required: req(), sheets, interestExpense: 15994, answers: {} });
    expect(cells).toContainEqual({ sheet: 'TRA111', ref: 'K6', value: 'No' });
    expect(cells).toContainEqual({ sheet: 'TRA111', ref: 'K11', value: 'Yes' });
    expect(cells).toContainEqual({ sheet: 'TRA111', ref: 'N11', value: 15994 });
  });

  it('leaves TRA111 manual above the €3M de-minimis', () => {
    const { cells, notes } = declarationCells({ required: req(), sheets, interestExpense: 3_500_000, answers: {} });
    expect(cells.find((c) => c.sheet === 'TRA111')).toBeUndefined();
    expect(notes.join(' ')).toMatch(/de-minimis/);
  });

  it('interview answers drive the client-specific p2 cells', () => {
    const { cells, notes } = declarationCells({
      required: req('p2!F76', 'p2!G60', 'p2!G62', 'p2!G34'),
      sheets,
      interestExpense: 0,
      answers: { auditReportQualified: 1, avgEmployees: 14, atadStandaloneEntity: 0 },
    });
    expect(cells).toContainEqual({ sheet: 'p2', ref: 'F76', value: 'Yes' });
    expect(cells).toContainEqual({ sheet: 'p2', ref: 'G60', value: 14 });
    expect(cells).toContainEqual({ sheet: 'p2', ref: 'G62', value: 'Yes' });
    expect(cells).toContainEqual({ sheet: 'p2', ref: 'G34', value: 'N' });
    expect(notes.join(' ')).toMatch(/C78/); // qualified → reminder to type the description
  });
});

describe('interestExpenseTotal', () => {
  it('sums Dr interest/finance-cost P&L accounts, ignores BS and interest income', () => {
    expect(
      interestExpenseTotal([
        { accountName: 'Bank interest paid', cyBalance: 1000 },
        { accountName: 'Finance costs', cyBalance: 500, statement: 'PL' },
        { accountName: 'Interest received', cyBalance: -200 },
        { accountName: 'Interest-bearing loan', cyBalance: 9999, statement: 'BS' },
        { accountName: 'Interest income earned', cyBalance: 50 },
      ])
    ).toBe(1500);
  });
});

describe('applyClosingEntry — post-closing ETB (closing RE, P&L still stated)', () => {
  // Northwind YA2024 real figures: closing RE 193,760 Dr (accumulated losses),
  // loss for the year 31,331 → filed 7501 = 162,429, 7600 = 193,760, 7050 = 31,331.
  const keys = new Set(['B_Sheet:3905', 'Income:7501', 'Income:7600', 'Income:7050']);
  const cells = [
    { sheet: 'B_Sheet' as const, cfrCode: 3905, amount: 193760 },
    { sheet: 'B_Sheet' as const, cfrCode: 3801, amount: -193760 }, // balances the BS on its own
    { sheet: 'Income' as const, cfrCode: 6170, amount: 30631 },
    { sheet: 'Income' as const, cfrCode: 6173, amount: 700 },
  ];

  it('derives the RE reconciliation memo rows and the year result', () => {
    const out = applyClosingEntry(cells, keys);
    const get = (code: number) => out.find((c) => c.cfrCode === code)?.amount;
    expect(get(3905)).toBe(193760); // untouched — already closing
    expect(get(7501)).toBe(162429);
    expect(get(7600)).toBe(193760);
    expect(get(7050)).toBe(31331);
  });

  it('does nothing without a mapped 3905 (no closing RE to reconcile against)', () => {
    const out = applyClosingEntry(cells.filter((c) => c.cfrCode !== 3905), keys);
    expect(out.find((c) => c.cfrCode === 7501)).toBeUndefined();
  });
});
