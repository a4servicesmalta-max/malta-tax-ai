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

/** Max maxed out (429) or the OAuth token is unusable (401/403) → try the API key instead. */
export function shouldFallBackToApiKey(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  return status === 429 || status === 401 || status === 403;
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
  return runWithFallback(params, {
    oauth: token ? (p) => oauthClient(token).messages.create(p as never) as unknown as Promise<AnthropicMessage> : undefined,
    api: key ? (p) => new Anthropic({ apiKey: key, ...BOUNDED }).messages.create(p as never) as unknown as Promise<AnthropicMessage> : undefined,
  });
}
