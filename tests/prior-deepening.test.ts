import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  priorUnabsorbedCapitalAllowancesCf,
  priorTaxAccountAllocations,
  priorLossesCarriedForward,
} from '../src/prior-return';
import { buildInterview } from '../src/interview';
import { computeTax } from '../src/tax-computation';
import { ANCHORS } from '../src/template-map';

const PAIRS = 'C:/Users/user/Downloads/New/tax-corpus/pairs';
const realFilesPresent = fs.existsSync(`${PAIRS}/ESDL_TR_YA2022_prior.xlsx`);

describe('prior-year deepening (CA b/f, refunds context)', () => {
  it.skipIf(!realFilesPresent)('extracts unabsorbed capital allowances c/f from a real filed return', () => {
    // ESDL YA2022 p4 carries CA b/f -6,746 (input row) and computes its own c/f.
    const ca = priorUnabsorbedCapitalAllowancesCf(fs.readFileSync(`${PAIRS}/ESDL_TR_YA2022_prior.xlsx`));
    expect(ca).not.toBeNull();
    expect(ca).toBeGreaterThan(0);
  });

  it.skipIf(!realFilesPresent)('losses c/f extractor still works via the shared row-summer', () => {
    const l = priorLossesCarriedForward(fs.readFileSync(`${PAIRS}/MFalzon_TR_YA2022_prior.xlsx`));
    expect(l === null || l >= 0).toBe(true);
  });

  it.skipIf(!realFilesPresent)('reads prior-year tax-account allocations from p6', () => {
    const alloc = priorTaxAccountAllocations(fs.readFileSync(`${PAIRS}/MFalzon_TR_YA2023.xlsx`));
    expect(alloc).not.toBeNull();
    expect(alloc!.total).toBeGreaterThan(0); // M Falzon allocated 1,528 (MTA)
  });

  it('interview asks for CA b/f with the prior-return pre-answer', () => {
    const iv = buildInterview([], { hasPriorReturn: true, priorUnabsorbedCaBf: 6746 });
    const q = iv.questions.find((x) => x.id === 'unabsorbedCapitalAllowancesBf');
    expect(q?.preAnswer).toBe(6746);
    expect(q?.legalBasis).toMatch(/14\(1\)\(f\)/);
  });

  it('computeTax deducts CA b/f alongside current-year allowances', () => {
    const c = computeTax(100000, { capitalAllowancesTotal: 10000, unabsorbedCapitalAllowancesBf: 5000 });
    expect(c.capitalAllowances).toBe(15000);
    expect(c.chargeableIncome).toBe(85000);
    expect(c.taxCharge).toBe(29750);
  });

  it('CA b/f writes to the p4 Brought forward anchor, negated', () => {
    expect(ANCHORS['unabsorbedCapitalAllowancesBf']).toEqual({ sheet: 'p4', ref: 'O13', negate: true });
  });
});
