import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server';

describe('auth gate', () => {
  it('runs open when APP_PASSWORD is unset (local/dev/tests)', async () => {
    vi.stubEnv('APP_PASSWORD', '');
    try {
      // gate disabled → an empty /api/session hits the route and 400s on missing files (not 401)
      const res = await request(createApp()).post('/api/session');
      expect(res.status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gates the API + pages and validates credentials when configured', async () => {
    vi.stubEnv('APP_USER', 'vacei');
    vi.stubEnv('APP_PASSWORD', 'secret123');
    vi.stubEnv('SESSION_SECRET', 's3cr3t-test');
    try {
      const app = createApp();

      // protected API without a cookie → 401 JSON
      expect((await request(app).post('/api/session')).status).toBe(401);

      // protected page without a cookie → redirect to /login
      const page = await request(app).get('/new-return');
      expect(page.status).toBe(302);
      expect(page.headers.location).toBe('/login');

      // wrong credentials → 401
      expect((await request(app).post('/api/login').send({ user: 'vacei', password: 'nope' })).status).toBe(401);

      // correct credentials → 200 + signed cookie
      const ok = await request(app).post('/api/login').send({ user: 'vacei', password: 'secret123' });
      expect(ok.status).toBe(200);
      const setCookie = ok.headers['set-cookie'][0];
      expect(setCookie).toMatch(/mt_auth=\d+\.[a-f0-9]{64}/);
      expect(setCookie).toMatch(/HttpOnly/);

      // with the cookie, the gate lets the request through (→ 400 missing files, not 401)
      const cookie = setCookie.split(';')[0];
      expect((await request(app).post('/api/session').set('Cookie', cookie)).status).toBe(400);

      // a forged/garbage cookie is rejected
      expect((await request(app).post('/api/session').set('Cookie', 'mt_auth=999999999999.deadbeef')).status).toBe(401);

      // the homepage stays public
      expect((await request(app).get('/')).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
