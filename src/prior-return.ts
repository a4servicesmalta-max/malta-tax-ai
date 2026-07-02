/**
 * Prior-year filed return intake. Deterministic extraction only:
 *  - which CfR codes the client used last year (mapping bias + review context)
 *  - filed values per code (prior-year cross-check)
 * Continuity balances beyond code rows (losses b/f, TRA5 TWDVs, tax accounts)
 * are pre-answered in the interview ONLY where template-map anchors exist.
 */
import { readCfrValues, type CfrValue } from './template-reader';
import type { EtbAccount, MappingProfile } from './domain';
import { applyMapping } from './mapping';

const CODE_SHEETS = ['B_Sheet', 'Income'];

export interface PriorReturnInfo {
  codes: Set<number>;
  values: CfrValue[];
}

export async function readPriorReturn(buffer: Buffer): Promise<PriorReturnInfo> {
  const values = await readCfrValues(buffer, CODE_SHEETS);
  return { codes: new Set(values.map((v) => v.cfrCode)), values };
}

export interface CrossCheckMismatch {
  sheet: string;
  cfrCode: number;
  priorReturnValue: number;
  mappedPyValue: number;
}

export interface CrossCheckResult {
  checkedCodes: number;
  mismatches: CrossCheckMismatch[];
}

const TOL = 1;

/**
 * Map the ETB's PRIOR-year balances with the proposed profile; the aggregates
 * should reproduce the prior return's filed values. Mismatches = mapping smells.
 */
export async function priorYearCrossCheck(
  priorReturn: Buffer,
  etb: EtbAccount[],
  profile: MappingProfile
): Promise<CrossCheckResult> {
  const prior = await readPriorReturn(priorReturn);
  const pyAsCy: EtbAccount[] = etb
    .filter((a) => a.pyBalance !== null)
    .map((a) => ({ ...a, cyBalance: a.pyBalance as number, pyBalance: null }));
  const mapped = applyMapping(pyAsCy, profile);

  const mismatches: CrossCheckMismatch[] = [];
  let checked = 0;
  for (const cell of mapped.codeCells) {
    const filed = prior.values.find((v) => v.sheet === cell.sheet && v.cfrCode === cell.cfrCode);
    if (!filed || filed.value === null) continue;
    checked++;
    if (Math.abs(filed.value - cell.amount) > TOL) {
      mismatches.push({
        sheet: cell.sheet,
        cfrCode: cell.cfrCode,
        priorReturnValue: filed.value,
        mappedPyValue: cell.amount,
      });
    }
  }
  return { checkedCodes: checked, mismatches };
}

export interface PriorReviewFinding {
  severity: 'error' | 'warning';
  message: string;
}

export interface PriorReturnReview {
  findings: PriorReviewFinding[];
  /** Sum of B_Sheet code values (should be ~0 in Dr+/Cr− convention). */
  balanceSheetNet: number;
  /** −(sum of Income code values) = net profit implied by the filed return. */
  impliedNetProfit: number;
}

/**
 * Deterministic error review of a filed prior-year return. Run BEFORE any
 * working is based on it; findings must be acknowledged by the preparer.
 */
export async function reviewPriorReturn(buffer: Buffer): Promise<PriorReturnReview> {
  const values = await readCfrValues(buffer, CODE_SHEETS);
  const findings: PriorReviewFinding[] = [];
  const bs = values.filter((v) => v.sheet === 'B_Sheet' && v.value !== null);
  const inc = values.filter((v) => v.sheet === 'Income' && v.value !== null);
  const balanceSheetNet = Math.round(bs.reduce((a, v) => a + (v.value as number), 0) * 100) / 100;
  const impliedNetProfit = Math.round(-inc.reduce((a, v) => a + (v.value as number), 0) * 100) / 100;
  if (Math.abs(balanceSheetNet) > 1) {
    findings.push({
      severity: 'error',
      message: `Prior-year return balance sheet does not balance: code values net to €${balanceSheetNet.toFixed(2)} (expected 0). Review the prior return before relying on it.`,
    });
  }
  if (bs.length === 0 && inc.length === 0) {
    findings.push({ severity: 'error', message: 'No code values could be read from the prior-year return — unsupported or empty template.' });
  }
  const noValue = values.filter((v) => v.value === null).length;
  if (noValue > 0 && bs.length + inc.length > 0) {
    findings.push({ severity: 'warning', message: `${noValue} code rows on the prior return carry no value — verify these were intentionally blank.` });
  }
  return { findings, balanceSheetNet, impliedNetProfit };
}
