import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server';

describe('auth gate', () => {
  it('is open in test mode (TAXGEN_OPEN=1) — functional endpoints are reachable', async () => {
    // no files → 400 (means the request reached the route, not blocked by the gate)
    expect((await request(createApp()).post('/api/session')).status).toBe(400);
  });

  it('gates protected pages + API when not open; public pages stay open', async () => {
    const prev = process.env.TAXGEN_OPEN;
    process.env.TAXGEN_OPEN = '0';
    try {
      const app = createApp();
      // protected API without a session → 401
      expect((await request(app).post('/api/session')).status).toBe(401);
      // protected page without a session → redirect to /login
      const page = await request(app).get('/new-return');
      expect(page.status).toBe(302);
      expect(page.headers.location).toBe('/login');
      // public pages served
      expect((await request(app).get('/login')).status).toBe(200);
      expect((await request(app).get('/signup')).status).toBe(200);
      // public auth API reachable (bad body → 400, not gated 401)
      expect((await request(app).post('/api/reset')).status).toBe(400);
    } finally {
      process.env.TAXGEN_OPEN = prev;
    }
  });
});
