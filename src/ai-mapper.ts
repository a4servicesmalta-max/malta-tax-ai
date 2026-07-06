/**
 * AI-proposed CoA -> CfR-code mapping. PROPOSAL ONLY: the preparer confirms
 * every rule; figures never come from the model. Falls back to the heuristic
 * table when unconfigured or on any parse/API failure.
 * Grounding: prior-year code set + firm-corpus example mappings in the prompt.
 */
import type { EtbAccount, ProposedRule } from './domain';
import { proposeMapping, fingerprintRules, type ProposalContext } from './mapping';
import { isAiConfigured, callAnthropic, type AiAuthOptions } from './ai-auth';
import { codeKeySet, type TemplateCode } from './template-codes';
import { commonCodeKeys } from './code-usage';

/** Max-first / API-key-fallback auth (see ai-auth), plus an optional model override. */
export interface AiMapperOptions extends AiAuthOptions {
  model?: string;
}

export interface AiProposal {
  rules: ProposedRule[];
  source: 'ai' | 'heuristic';
}

/**
 * Account names are client-supplied spreadsheet text. Collapse control
 * characters, tabs and newlines to single spaces so a hostile name cannot
 * inject fake columns/rows (or model instructions) into the prompt.
 */
export function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
}

const SYSTEM = `You map Maltese company ledger accounts to official CfR corporate tax return account codes
(balance sheet on sheet "B_Sheet", profit & loss on sheet "Income").
When a VALID CODES list is provided, you MUST use only codes from that list — they are the data-entry
rows that exist on this client's template; any other code cannot be written and would leave the return
incomplete. Map every account to the best-fitting code; prefer the most specific line over a catch-all.
Reply with JSON only: {"rules":[{"ledgerCode":string,"cfrCode":number,"sheet":"B_Sheet"|"Income","confidence":number}]}
Omit an account only when nothing on the list plausibly fits — a human preparer reviews everything.
Never invent amounts; you only classify accounts.`;

/** Compact "VALID CODES" section for the prompt, grouped per sheet. A ★ marks lines
 *  real preparers commonly populate (from the filed-return corpus) — a tie-breaker
 *  nudge toward real-world lines, not a constraint. */
function templateCodesPrompt(codes: TemplateCode[]): string {
  const common = commonCodeKeys();
  const bySheet: Record<string, string[]> = {};
  for (const c of codes) {
    const star = common.has(`${c.sheet}:${c.code}`) ? ' ★' : '';
    (bySheet[c.sheet] ??= []).push(`${c.code}${c.label ? ` = ${sanitizeName(c.label)}` : ''}${star}`);
  }
  return Object.entries(bySheet)
    .map(([sheet, lines]) => `${sheet}:\n${lines.join('\n')}`)
    .join('\n\n');
}

/**
 * Prior-year value fingerprints override any other proposal for their accounts:
 * "the firm filed this exact figure on that line last year" is filed fact, not
 * model opinion. Template-validity still applies.
 */
function overlayFingerprints(rules: ProposedRule[], accounts: EtbAccount[], ctx: ProposalContext): ProposedRule[] {
  if (!ctx.priorYearValues?.size) return rules;
  const fp = fingerprintRules(accounts, ctx.priorYearValues);
  if (!fp.length) return rules;
  const validKeys = ctx.templateCodes?.length ? codeKeySet(ctx.templateCodes) : null;
  const byLedger = new Map(rules.map((r) => [r.ledgerCode, r]));
  for (const r of fp) {
    if (validKeys && !validKeys.has(`${r.sheet}:${r.cfrCode}`)) continue;
    byLedger.set(r.ledgerCode, r);
  }
  return [...byLedger.values()];
}

export async function proposeMappingAI(
  accounts: EtbAccount[],
  ctx: ProposalContext,
  opts: AiMapperOptions = {}
): Promise<AiProposal> {
  const fallback = (): AiProposal => ({
    rules: overlayFingerprints(proposeMapping(accounts, ctx).rules, accounts, ctx),
    source: 'heuristic',
  });
  if (!isAiConfigured(opts)) return fallback();

  try {
    const priorNote = ctx.priorYearCodes?.size
      ? `Codes used on this client's prior-year return (prefer these where sensible): ${[...ctx.priorYearCodes].join(', ')}.`
      : '';
    const codesNote = ctx.templateCodes?.length
      ? `VALID CODES on this template (use ONLY these; ★ = line commonly used on real filed returns, prefer it when it fits):\n${templateCodesPrompt(ctx.templateCodes)}\n\n`
      : '';
    const res = await callAnthropic(
      {
        model: opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
        // Sized for real ETBs (~100 accounts × one JSON rule each); a too-small
        // budget truncates the JSON mid-list and the whole proposal is lost.
        max_tokens: 8000,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `${codesNote}${priorNote}\nAccounts:\n${accounts
              .map((a) => `${a.accountCode}\t${sanitizeName(a.accountName)}\t${a.cyBalance >= 0 ? 'Dr' : 'Cr'}`)
              .join('\n')}`,
          },
        ],
      },
      opts
    );
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    // Long real-world responses are occasionally imperfect JSON (prose wrapper,
    // truncation, a malformed element mid-array). Each rule is a flat object,
    // so salvage them individually instead of all-or-nothing parsing.
    let ruleObjs: unknown[];
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      ruleObjs = Array.isArray(parsed.rules) ? parsed.rules : [];
    } catch {
      ruleObjs = [...text.matchAll(/\{[^{}]*"ledgerCode"[^{}]*\}/g)].flatMap((m) => {
        try {
          return [JSON.parse(m[0])];
        } catch {
          return [];
        }
      });
      console.warn(`[ai-mapper] JSON imperfect — salvaged ${ruleObjs.length} rule objects`);
    }
    if (!ruleObjs.length) return fallback();
    // Safe: the filter below validates every field of every rule.
    const parsed = { rules: ruleObjs as ProposedRule[] };
    const knownLedgerCodes = new Set(accounts.map((a) => a.accountCode));
    // Template-aware hard filter: a hallucinated code would land nowhere and
    // leave a section of the return empty — drop it so the row shows unmapped.
    const validKeys = ctx.templateCodes?.length ? codeKeySet(ctx.templateCodes) : null;
    const rules: ProposedRule[] = parsed.rules.filter(
      (r: ProposedRule) =>
        typeof r.ledgerCode === 'string' &&
        knownLedgerCodes.has(r.ledgerCode) &&
        typeof r.cfrCode === 'number' &&
        Number.isFinite(r.cfrCode) &&
        Number.isInteger(r.cfrCode) &&
        r.cfrCode > 0 &&
        (r.sheet === 'B_Sheet' || r.sheet === 'Income') &&
        (!validKeys || validKeys.has(`${r.sheet}:${r.cfrCode}`)) &&
        typeof r.confidence === 'number' &&
        Number.isFinite(r.confidence) &&
        r.confidence >= 0 &&
        r.confidence <= 1
    );
    return rules.length ? { rules: overlayFingerprints(rules, accounts, ctx), source: 'ai' } : fallback();
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.warn(`[ai-mapper] failed, using heuristic: status=${err?.status ?? '?'} ${String(err?.message ?? '').slice(0, 160)}`);
    return fallback();
  }
}
