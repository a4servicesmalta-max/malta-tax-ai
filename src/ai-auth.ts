/**
 * Claude auth for this tool's advisory AI features (mapping proposal + the
 * reasonableness review). Preference order:
 *   1. Claude Max / Pro subscription via an OAuth token (billed to the plan);
 *   2. on a Max rate-limit / usage cap (HTTP 429) — or an unusable token
 *      (401/403) — automatically fall back to the pay-per-token API key.
 *
 * The OAuth mechanics mirror the VACEI portal's proven factory: Bearer auth,
 * the `oauth-2025-04-20` beta header, `x-api-key` suppressed, and the Claude
 * Code identity prepended to the system prompt (Max/Pro OAuth tokens from
 * `claude setup-token` are scoped to Claude Code and are otherwise rejected).
 *
 * Env:
 *   CLAUDE_CODE_OAUTH_TOKEN  (alias ANTHROPIC_AUTH_TOKEN) — sk-ant-oat… (Max/Pro)
 *   ANTHROPIC_API_KEY        — fallback plan (needs a positive credit balance)
 * Set either, both, or neither. Neither → AI features report unavailable.
 */
import Anthropic from '@anthropic-ai/sdk';

export type AnthropicMessage = { content: Array<{ type: string; text?: string }> };
export type AnthropicCall = (params: Record<string, unknown>) => Promise<AnthropicMessage>;

export interface AiAuthOptions {
  /** Override the API key (else ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Override the OAuth/subscription token (else CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN). */
  authToken?: string;
  /** Test seam: bypasses auth and real HTTP entirely. */
  createMessage?: AnthropicCall;
}

/** Required first system block for OAuth (subscription) tokens; see file header. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

export function resolveOAuthToken(opts: AiAuthOptions = {}): string | undefined {
  return (
    trimmed(opts.authToken) ??
    trimmed(process.env.CLAUDE_CODE_OAUTH_TOKEN) ??
    trimmed(process.env.ANTHROPIC_AUTH_TOKEN)
  );
}

export function resolveApiKey(opts: AiAuthOptions = {}): string | undefined {
  return trimmed(opts.apiKey) ?? trimmed(process.env.ANTHROPIC_API_KEY);
}

export function isAiConfigured(opts: AiAuthOptions = {}): boolean {
  return Boolean(opts.createMessage || resolveOAuthToken(opts) || resolveApiKey(opts));
}

/** Prepend the Claude Code identity as the first system block (new object, no mutation). */
export function withClaudeCodeIdentity(params: Record<string, unknown>): Record<string, unknown> {
  const identity = { type: 'text', text: CLAUDE_CODE_IDENTITY };
  const system = params.system;
  if (system == null || system === '') return { ...params, system: [identity] };
  if (typeof system === 'string') return { ...params, system: [identity, { type: 'text', text: system }] };
  if (Array.isArray(system)) return { ...params, system: [identity, ...system] };
  return params;
}

/**
 * Try the API key when the Max leg is maxed out (429), unusable (401/403), or
 * simply unreachable — timeouts, connection failures and deadline trips have
 * no status. The one case NOT worth retrying on the paid key is a 400: an
 * invalid request fails identically on both legs.
 * Live evidence (2026-07-07): the Max leg hung rather than erroring, so a
 * status-code allowlist alone left the API key unused during the outage.
 */
export function shouldFallBackToApiKey(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  return status !== 400;
}

/**
 * Try the OAuth (Max) call first; on a maxed-out/unusable error fall back to the
 * API-key call. Pure over its injected callers — the real SDK clients are wired
 * in by callAnthropic, but this core is unit-tested with fakes.
 */
export async function runWithFallback(
  params: Record<string, unknown>,
  creators: { oauth?: AnthropicCall; api?: AnthropicCall }
): Promise<AnthropicMessage> {
  if (creators.oauth) {
    try {
      return await creators.oauth(withClaudeCodeIdentity(params));
    } catch (err) {
      if (creators.api && shouldFallBackToApiKey(err)) return creators.api(params);
      throw err;
    }
  }
  if (creators.api) return creators.api(params);
  throw new Error('No Anthropic credentials configured.');
}

/**
 * Advisory calls must be BOUNDED: the SDK's 10-min default timeout × retries
 * left /api/session awaiting a black-holed API response for 30+ minutes with
 * the heuristic fallback unreachable (live outage, 2026-07-07). 90s per
 * attempt × 2 attempts caps AI latency at ~3 min before callers degrade.
 */
const BOUNDED = { timeout: 90_000, maxRetries: 1 } as const;

function oauthClient(token: string): Anthropic {
  return new Anthropic({
    apiKey: null, // suppress x-api-key — sending it alongside the bearer token breaks subscription auth
    authToken: token,
    defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    ...BOUNDED,
  });
}

/**
 * Hard deadlines, SDK timeouts included. Live evidence (2026-07-07): requests
 * idled inside messages.create without the SDK timeout firing on the deployed
 * runtime, so the route never responded. The races are runtime-agnostic —
 * whatever the SDK does, callers get a rejection by the deadline.
 *
 * PER-LEG (100s): bounds one auth leg so a hung Max call still leaves budget
 * for the API-key fallback. TOTAL (220s): backstop over the whole chain.
 */
const LEG_DEADLINE_MS = 100_000;
const TOTAL_DEADLINE_MS = 220_000;

function withDeadline<T>(work: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms / 1000}s hard deadline`)), ms);
    timer.unref(); // never hold the process open for a watchdog
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

/**
 * Send one messages.create with Max-first, API-key-fallback auth. Throws only
 * when the configured path(s) all fail; callers already degrade on throw.
 */
export async function callAnthropic(
  params: Record<string, unknown>,
  opts: AiAuthOptions = {}
): Promise<AnthropicMessage> {
  if (opts.createMessage) return opts.createMessage(params);
  const token = resolveOAuthToken(opts);
  const key = resolveApiKey(opts);
  const t0 = Date.now();
  try {
    return await withDeadline(
      runWithFallback(params, {
        oauth: token
          ? (p) =>
              withDeadline(
                oauthClient(token).messages.create(p as never) as unknown as Promise<AnthropicMessage>,
                'anthropic oauth leg',
                LEG_DEADLINE_MS
              )
          : undefined,
        api: key
          ? (p) =>
              withDeadline(
                new Anthropic({ apiKey: key, ...BOUNDED }).messages.create(p as never) as unknown as Promise<AnthropicMessage>,
                'anthropic api-key leg',
                LEG_DEADLINE_MS
              )
          : undefined,
      }),
      'anthropic call',
      TOTAL_DEADLINE_MS
    );
  } finally {
    console.info(`[ai] messages.create settled in ${Date.now() - t0}ms`);
  }
}
