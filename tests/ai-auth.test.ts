import { describe, it, expect, vi } from 'vitest';
import {
  resolveOAuthToken,
  resolveApiKey,
  isAiConfigured,
  withClaudeCodeIdentity,
  shouldFallBackToApiKey,
  runWithFallback,
  callAnthropic,
  CLAUDE_CODE_IDENTITY,
} from '../src/ai-auth';

const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const ok = (text: string) => ({ content: [{ type: 'text', text }] });

describe('ai-auth resolution', () => {
  it('prefers the OAuth token and honours the alias var', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-primary');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat-alias');
    try {
      expect(resolveOAuthToken()).toBe('sk-ant-oat-primary');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('opts override env; blank env is treated as unset', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '   ');
    try {
      expect(resolveApiKey()).toBeUndefined();
      expect(resolveApiKey({ apiKey: 'sk-x' })).toBe('sk-x');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('isAiConfigured is true for a token, a key, or an injected seam; false for none', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    try {
      expect(isAiConfigured()).toBe(false);
      expect(isAiConfigured({ authToken: 't' })).toBe(true);
      expect(isAiConfigured({ apiKey: 'k' })).toBe(true);
      expect(isAiConfigured({ createMessage: async () => ok('{}') })).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('withClaudeCodeIdentity', () => {
  it('prepends the identity as the first system block (string system)', () => {
    const out = withClaudeCodeIdentity({ system: 'Map accounts.', max_tokens: 10 }) as {
      system: Array<{ text: string }>;
      max_tokens: number;
    };
    expect(out.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(out.system[1].text).toBe('Map accounts.');
    expect(out.max_tokens).toBe(10); // other params preserved
  });

  it('adds an identity block when there is no system prompt', () => {
    const out = withClaudeCodeIdentity({}) as { system: Array<{ text: string }> };
    expect(out.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }]);
  });
});

describe('shouldFallBackToApiKey', () => {
  it('falls back on maxed-out (429) and unusable-token (401/403), not on other errors', () => {
    expect(shouldFallBackToApiKey(err(429))).toBe(true);
    expect(shouldFallBackToApiKey(err(401))).toBe(true);
    expect(shouldFallBackToApiKey(err(403))).toBe(true);
    expect(shouldFallBackToApiKey(err(400))).toBe(false);
    expect(shouldFallBackToApiKey(err(500))).toBe(false);
    expect(shouldFallBackToApiKey(new Error('network'))).toBe(false);
  });
});

describe('runWithFallback', () => {
  it('uses OAuth first (identity prepended) and never touches the API key on success', async () => {
    const oauth = vi.fn(async (p: Record<string, unknown>) => ok('oauth'));
    const api = vi.fn(async () => ok('api'));
    const res = await runWithFallback({ system: 'S' }, { oauth, api });
    expect(res).toEqual(ok('oauth'));
    expect(api).not.toHaveBeenCalled();
    const sentSystem = (oauth.mock.calls[0][0] as { system: Array<{ text: string }> }).system;
    expect(sentSystem[0].text).toBe(CLAUDE_CODE_IDENTITY);
  });

  it('falls back to the API key when Max is maxed out (429), sending the ORIGINAL params', async () => {
    const oauth = vi.fn(async () => {
      throw err(429);
    });
    const api = vi.fn(async (p: Record<string, unknown>) => ok('api'));
    const res = await runWithFallback({ system: 'S' }, { oauth, api });
    expect(res).toEqual(ok('api'));
    // API path gets the un-shimmed params (no Claude Code identity)
    expect(api.mock.calls[0][0].system).toBe('S');
  });

  it('does NOT fall back on a non-maxed-out error — it propagates', async () => {
    const oauth = vi.fn(async () => {
      throw err(500);
    });
    const api = vi.fn(async () => ok('api'));
    await expect(runWithFallback({}, { oauth, api })).rejects.toMatchObject({ status: 500 });
    expect(api).not.toHaveBeenCalled();
  });

  it('rethrows the maxed-out error when no API key is available to fall back to', async () => {
    const oauth = vi.fn(async () => {
      throw err(429);
    });
    await expect(runWithFallback({}, { oauth })).rejects.toMatchObject({ status: 429 });
  });

  it('uses the API key directly when no OAuth token is present', async () => {
    const api = vi.fn(async () => ok('api'));
    const res = await runWithFallback({ system: 'S' }, { api });
    expect(res).toEqual(ok('api'));
  });

  it('throws when neither credential is available', async () => {
    await expect(runWithFallback({}, {})).rejects.toThrow(/no anthropic credentials/i);
  });
});

describe('callAnthropic', () => {
  it('routes through an injected seam without touching real auth', async () => {
    const seam = vi.fn(async () => ok('seam'));
    const res = await callAnthropic({ system: 'S' }, { createMessage: seam });
    expect(res).toEqual(ok('seam'));
    expect(seam).toHaveBeenCalledOnce();
  });
});
