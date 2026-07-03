/**
 * AI reasonableness review of the DRAFT tax computation — an advisory second
 * set of eyes before the return is filled. It reads the client's accounts, the
 * deterministic computation and the confirmed answers, and raises review points
 * a senior would question (missing add-backs, capital-allowance/loss figures
 * that look off, unusual items, mapping smells).
 *
 * ADVISORY ONLY, consistent with the tool's golden rule: the model raises
 * concerns for a human to judge; it never computes or proposes an amount to
 * enter on the return. Env-gated like the AI mapper — unconfigured or any
 * failure yields `available:false` with an empty finding list; it never throws
 * and never blocks generation.
 */
import type { EtbAccount } from './domain';
import { sanitizeName } from './ai-mapper';
import { isAiConfigured, callAnthropic, type AiAuthOptions } from './ai-auth';
import type { TaxComputation } from './tax-computation';

export interface ReviewFinding {
  severity: 'warning' | 'info';
  message: string;
}

export interface ReasonablenessReview {
  available: boolean;
  findings: ReviewFinding[];
  /** Why the review is unavailable (unconfigured / failed), shown to the preparer. */
  note?: string;
}

/** Max-first / API-key-fallback auth (see ai-auth), plus an optional model override. */
export interface ReviewOptions extends AiAuthOptions {
  model?: string;
}

const SYSTEM = `You are a senior Maltese corporate income tax reviewer performing a REASONABLENESS review of a
draft tax computation prepared by a colleague, before it is filed on the official CfR return.
You are given the client's ledger accounts (code, name, Dr/Cr balance), the draft tax computation, and the
confirmed tax-adjustment answers. Raise the points a reviewer would question before signing off, e.g.:
- an add-back that appears missing given the accounts (depreciation/amortisation charged but not added back,
  fines/penalties, donations, entertainment not adjusted);
- capital allowances or losses that look inconsistent with the accounts;
- unusually large or out-of-place items, or a mapping that looks wrong.
Reply with JSON only: {"findings":[{"severity":"warning"|"info","message":string}]}
"warning" = a likely error or omission the preparer should fix; "info" = worth confirming but may be intentional.
Do NOT compute, guess, or propose any amount to enter on the return — you only raise review points for a human
to judge. If nothing looks wrong, return {"findings":[]}.`;

const eur = (n: number) => n.toLocaleString('en-MT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Compact, human-readable rendering of the computation for the prompt. */
function computationLines(c: TaxComputation): string {
  const lines = [
    `Net profit/(loss) per accounts: ${eur(c.netProfitPerAccounts)}`,
    ...c.addBacks.map((l) => `Add back - ${l.label}: ${eur(l.amount)}`),
    ...c.deductions.map((l) => `Deduct - ${l.label}: ${eur(l.amount)}`),
    `Adjusted profit before capital allowances: ${eur(c.adjustedProfit)}`,
    `Capital allowances: ${eur(c.capitalAllowances)}`,
    `Losses brought forward: ${eur(c.lossesBroughtForward)} (utilised ${eur(c.lossesUtilised)}, c/f ${eur(c.lossesCarriedForward)})`,
    `Chargeable income: ${eur(c.chargeableIncome)}`,
    `Tax charge @ 35%: ${eur(c.taxCharge)}`,
  ];
  return lines.join('\n');
}

export async function reasonablenessReview(
  accounts: EtbAccount[],
  computation: TaxComputation,
  opts: ReviewOptions = {}
): Promise<ReasonablenessReview> {
  if (!isAiConfigured(opts)) {
    return {
      available: false,
      findings: [],
      note: 'AI reasonableness review is not configured (set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY). The deterministic computation and checks still apply.',
    };
  }

  try {
    const res = await callAnthropic(
      {
        model: opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
        // Real ETBs yield long finding lists; a truncated response fails JSON
        // parsing and loses the whole review.
        max_tokens: 4000,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `Ledger accounts:\n` +
              accounts
                .map((a) => `${a.accountCode}\t${sanitizeName(a.accountName)}\t${a.cyBalance >= 0 ? 'Dr' : 'Cr'} ${eur(Math.abs(a.cyBalance))}`)
                .join('\n') +
              `\n\nDraft tax computation:\n${computationLines(computation)}`,
          },
        ],
      },
      opts
    );
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    // Models sometimes wrap the JSON in fences or add prose around it — parse
    // the outermost {...} slice, not the raw text.
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!Array.isArray(parsed.findings)) return { available: true, findings: [] };
    const findings: ReviewFinding[] = parsed.findings
      .filter(
        (f: ReviewFinding) =>
          f &&
          (f.severity === 'warning' || f.severity === 'info') &&
          typeof f.message === 'string' &&
          f.message.trim().length > 0
      )
      .slice(0, 25)
      .map((f: ReviewFinding) => ({ severity: f.severity, message: f.message.trim().slice(0, 500) }));
    return { available: true, findings };
  } catch (e) {
    // Diagnosable in server logs (status/message only — never the credential).
    const err = e as { status?: number; message?: string };
    console.warn(`[ai-review] failed: status=${err?.status ?? '?'} ${String(err?.message ?? '').slice(0, 160)}`);
    return {
      available: false,
      findings: [],
      note: 'AI reasonableness review could not be completed (service error). The deterministic computation and checks still apply.',
    };
  }
}
