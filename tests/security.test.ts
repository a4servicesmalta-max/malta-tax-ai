import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server';
import { syntheticCfrWorkbook } from './helpers/synthetic';

describe('security hardening', () => {
  it('sets security headers on responses', async () => {
    const res = await request(createApp()).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });

  it('rejects non-spreadsheet uploads via the multer file filter', async () => {
    const template = await syntheticCfrWorkbook({ bSheet: [], income: [] });
    const res = await request(createApp())
      .post('/api/session')
      .attach('etb', Buffer.from('not a spreadsheet'), 'malware.txt')
      .attach('template', template, 'template.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported file type/i);
  });

  it('rate-limits repeated login attempts', async () => {
    vi.stubEnv('APP_USER', 'vacei');
    vi.stubEnv('APP_PASSWORD', 'secret123');
    try {
      const app = createApp();
      let sawRateLimit = false;
      for (let i = 0; i < 13; i++) {
        const res = await request(app).post('/api/login').send({ user: 'vacei', password: 'wrong' });
        if (res.status === 429) {
          sawRateLimit = true;
          expect(res.body.error).toMatch(/too many/i);
          break;
        }
      }
      expect(sawRateLimit).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
