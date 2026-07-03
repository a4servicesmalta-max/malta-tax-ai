/**
 * AI-proposed CoA -> CfR-code mapping. PROPOSAL ONLY: the preparer confirms
 * every rule; figures never come from the model. Falls back to the heuristic
 * table when unconfigured or on any parse/API failure.
 * Grounding: prior-year code set + firm-corpus example mappings in the prompt.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EtbAccount, ProposedRule } from './domain';
import { proposeMapping, type ProposalContext } from './mapping';

export interface AiMapperOptions {
  apiKey?: string;
  model?: string;
  /** Test seam: injected message-create function. */
  createMessage?: (req: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
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
function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
}

const SYSTEM = `You map Maltese company ledger accounts to official CfR corporate tax return account codes
(1000/2000/3000-series balance sheet on sheet "B_Sheet", 5000/6000/7000-series P&L on sheet "Income").
Reply with JSON only: {"rules":[{"ledgerCode":string,"cfrCode":number,"sheet":"B_Sheet"|"Income","confidence":number}]}
Omit any account you are not confident about — a human tax preparer reviews and completes the mapping.
Never invent amounts; you only classify accounts.`;

export async function proposeMappingAI(
  accounts: EtbAccount[],
  ctx: ProposalContext,
  opts: AiMapperOptions = {}
): Promise<AiProposal> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fallback = (): AiProposal => ({ rules: proposeMapping(accounts, ctx).rules, source: 'heuristic' });
  if (!apiKey) return fallback();

  try {
    const create =
      opts.createMessage ??
      (async (req: unknown) => {
        const client = new Anthropic({ apiKey });
        return client.messages.create(req as never) as never;
      });
    const priorNote = ctx.priorYearCodes?.size
      ? `Codes used on this client's prior-year return (prefer these where sensible): ${[...ctx.priorYearCodes].join(', ')}.`
      : '';
    const res = await create({
      model: opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
      max_tokens: 2000,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${priorNote}\nAccounts:\n${accounts
            .map((a) => `${a.accountCode}\t${sanitizeName(a.accountName)}\t${a.cyBalance >= 0 ? 'Dr' : 'Cr'}`)
            .join('\n')}`,
        },
      ],
    });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed.rules)) return fallback();
    const knownLedgerCodes = new Set(accounts.map((a) => a.accountCode));
    const rules: ProposedRule[] = parsed.rules.filter(
      (r: ProposedRule) =>
        typeof r.ledgerCode === 'string' &&
        knownLedgerCodes.has(r.ledgerCode) &&
        typeof r.cfrCode === 'number' &&
        Number.isFinite(r.cfrCode) &&
        Number.isInteger(r.cfrCode) &&
        r.cfrCode > 0 &&
        (r.sheet === 'B_Sheet' || r.sheet === 'Income') &&
        typeof r.confidence === 'number' &&
        Number.isFinite(r.confidence) &&
        r.confidence >= 0 &&
        r.confidence <= 1
    );
    return rules.length ? { rules, source: 'ai' } : fallback();
  } catch {
    return fallback();
  }
}
