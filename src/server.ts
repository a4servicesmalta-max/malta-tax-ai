/**
 * Standalone web app: upload ETB + FS + blank CfR template (+ prior return),
 * confirm mapping + interview, download filled return + computation summary.
 * Sessions are in-memory (single-workstation tool, v1).
 */
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import type { EtbAccount, MappingProfile, MappingRule } from './domain';
import { parseEtb } from './etb-parser';
import { extractFsFigures, tieCheck } from './fs-tie-check';
import {
  readPriorReturn,
  priorYearCrossCheck,
  reviewPriorReturn,
  priorLossesCarriedForward,
  type PriorReturnReview,
} from './prior-return';
import { proposeMappingAI } from './ai-mapper';
import { applyMapping, netProfitFromMapping } from './mapping';
import { buildInterview, fillsFromAnswers } from './interview';
import { computeTax } from './tax-computation';
import { reasonablenessReview } from './reasonableness-review';
import { notifyAdmin } from './email';
import { fillCfrReturn } from './template-writer';
import { renderComputationSummary } from './computation-summary';
import { ANCHORS } from './template-map';
import {
  registerUser,
  verifyEmail,
  loginUser,
  requestReset,
  resetPassword,
  currentUser,
  consumeCredit,
  bootstrapAdmin,
} from './accounts';
import { saveReturn, listReturns, findReturn, readReturnFile } from './store';

interface Session {
  accounts: EtbAccount[];
  warnings: string[];
  template: Buffer;
  prior?: { codes: Set<number> };
  priorBuffer?: Buffer;
  priorReview?: PriorReturnReview;
  fsFigures?: ReturnType<typeof extractFsFigures>;
  output?: { xlsx: Buffer; summary: string };
}

export function createApp() {
  bootstrapAdmin(); // create the env-configured admin account if missing (idempotent)
  const app = express();
  app.set('trust proxy', 1); // behind Render/Railway proxy: real client IP + protocol
  app.use(express.json({ limit: '5mb' }));

  // Security headers (parity with FS AI Review). CSP allows our inline styles/
  // scripts and the web-font hosts; everything else is same-origin.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://db.onlinewebfonts.com https://fonts.googleapis.com",
        "font-src 'self' https://db.onlinewebfonts.com https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 60 * 1024 * 1024 },
    // Only spreadsheet inputs are ever expected — reject anything else early.
    fileFilter: (_req, file, cb) => {
      if (/\.(xlsx|xls|xlsm)$/i.test(file.originalname)) return cb(null, true);
      cb(new Error(`Unsupported file type "${file.originalname}" — upload .xlsx, .xls or .xlsm`));
    },
  });
  const sessions = new Map<string, Session>();

  // ---- Accounts + session auth ----
  // Every request through a protected page/API needs a valid user session cookie.
  // TAXGEN_OPEN=1 bypasses the gate for local dev/tests (never set in prod).
  const OPEN = process.env.TAXGEN_OPEN === '1';
  const cookieToken = (req: express.Request): string | undefined => {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)mt_auth=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : undefined;
  };
  const setSession = (req: express.Request, res: express.Response, token: string) => {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader(
      'Set-Cookie',
      `mt_auth=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${12 * 3600}`
    );
  };

  // Per-IP sliding-window rate limit — throttles brute-force against auth. Memory-bounded.
  const authHits = new Map<string, number[]>();
  const rateLimited = (ip: string, limit = 10, windowMs = 300_000): boolean => {
    const now = Date.now();
    const hits = (authHits.get(ip) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    authHits.set(ip, hits);
    if (authHits.size > 5000) authHits.clear();
    return hits.length > limit;
  };

  app.post('/api/register', async (req, res) => {
    if (rateLimited(req.ip || '?', 8)) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
    const { email, password, firm } = (req.body || {}) as { email?: string; password?: string; firm?: string };
    const r = await registerUser(email || '', password || '', firm || '');
    if (!r.ok) return res.status(400).json({ error: r.error });
    void notifyAdmin('Malta Tax AI — new signup', `New signup: ${email}${firm ? ` (${firm})` : ''}`);
    res.json({ ok: true, verify: true });
  });

  app.get('/verify', (req, res) => {
    const ok = verifyEmail(String(req.query.token || ''));
    res.redirect(ok ? '/login?verified=1' : '/login?verified=0');
  });

  app.post('/api/login', (req, res) => {
    if (rateLimited(req.ip || '?')) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
    const { email, password } = (req.body || {}) as { email?: string; password?: string };
    const r = loginUser(email || '', password || '');
    if (!r.ok) return res.status(r.needsVerify ? 403 : 401).json({ error: r.error });
    setSession(req, res, r.token!);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'mt_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.post('/api/reset-request', async (req, res) => {
    if (rateLimited(req.ip || '?', 6)) return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
    await requestReset((req.body || {}).email || '');
    res.json({ ok: true }); // always ok — never reveal whether the account exists
  });

  app.post('/api/reset', (req, res) => {
    const { token, password } = (req.body || {}) as { token?: string; password?: string };
    const r = resetPassword(String(token || ''), String(password || ''));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  });

  const PUBLIC_PAGES = new Set([
    '/', '/index.html', '/login', '/login.html', '/signup', '/signup.html', '/reset', '/reset.html', '/verify',
  ]);
  const PUBLIC_API = new Set(['/api/register', '/api/login', '/api/logout', '/api/reset-request', '/api/reset']);

  app.use((req, res, next) => {
    if (OPEN) {
      res.locals.userId = 'test-user';
      return next();
    }
    const p = req.path;
    if (PUBLIC_API.has(p)) return next();
    // Static assets (css/js/png/mp4/svg…) are public — but never treat an /api
    // route as an asset just because it ends in .xlsx/.html.
    const isAsset = !p.startsWith('/api/') && /\.[a-z0-9]+$/i.test(p) && !p.endsWith('.html');
    if (isAsset || PUBLIC_PAGES.has(p)) return next();
    const user = currentUser(cookieToken(req));
    if (user) {
      res.locals.userId = user.id;
      return next();
    }
    if (p.startsWith('/api/')) return res.status(401).json({ error: 'not authenticated' });
    return res.redirect('/login');
  });

  app.get('/api/me', (req, res) => {
    const u = currentUser(cookieToken(req));
    if (!u) return res.status(401).json({ error: 'not authenticated' });
    res.json({ email: u.email, firm: u.firm, credits: u.credits, emailVerified: u.emailVerified });
  });

  app.get('/api/returns', (req, res) => {
    const uid = res.locals.userId as string;
    res.json({
      returns: listReturns(uid).map((r) => ({
        id: r.id,
        clientName: r.clientName,
        ya: r.ya,
        taxCharge: r.taxCharge,
        createdAt: r.createdAt,
      })),
    });
  });

  const serveReturnFile = (ext: 'xlsx' | 'html') => (req: express.Request, res: express.Response) => {
    const row = findReturn(req.params.id);
    if (!row || row.userId !== res.locals.userId) return res.status(404).json({ error: 'not found' });
    const buf = readReturnFile(row.id, ext);
    if (!buf) return res.status(404).json({ error: 'not found' });
    if (ext === 'xlsx') {
      res
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .setHeader('Content-Disposition', 'attachment; filename="tax-return-filled.xlsx"');
    } else {
      res.type('html');
    }
    res.send(buf);
  };
  app.get('/api/returns/:id/return.xlsx', serveReturnFile('xlsx'));
  app.get('/api/returns/:id/summary.html', serveReturnFile('html'));

  app.post(
    '/api/session',
    upload.fields([
      { name: 'etb', maxCount: 1 },
      { name: 'fs', maxCount: 1 },
      { name: 'template', maxCount: 1 },
      { name: 'prior', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const etbFile = files?.etb?.[0];
        const tplFile = files?.template?.[0];
        if (!etbFile || !tplFile) return res.status(400).json({ error: 'etb and template files are required' });

        const parsed = parseEtb(etbFile.buffer);
        const warnings = [...parsed.warnings];
        const session: Session = { accounts: parsed.accounts, warnings, template: tplFile.buffer };

        if (files?.fs?.[0]) session.fsFigures = extractFsFigures(files.fs[0].buffer);
        let priorCodes: Set<number> | undefined;
        let priorReview: PriorReturnReview | undefined;
        if (files?.prior?.[0]) {
          session.priorBuffer = files.prior[0].buffer;
          // Review-first gate: run BEFORE the prior return is used as a basis for anything.
          priorReview = await reviewPriorReturn(files.prior[0].buffer);
          session.priorReview = priorReview;
          const info = await readPriorReturn(files.prior[0].buffer);
          priorCodes = info.codes;
          session.prior = { codes: info.codes };
        }

        const proposal = await proposeMappingAI(parsed.accounts, { priorYearCodes: priorCodes });
        const interview = buildInterview(parsed.accounts, {
          hasPriorReturn: !!priorCodes,
          priorLossesBroughtForward: session.priorBuffer
            ? priorLossesCarriedForward(session.priorBuffer)
            : null,
        });

        let crossCheck = null;
        if (session.priorBuffer && proposal.rules.length) {
          const profile: MappingProfile = { rules: proposal.rules };
          crossCheck = await priorYearCrossCheck(session.priorBuffer, parsed.accounts, profile);
        }

        const id = crypto.randomUUID();
        sessions.set(id, session);
        res.json({
          sessionId: id,
          accounts: parsed.accounts,
          proposal,
          interview,
          warnings,
          fsFigures: session.fsFigures ?? null,
          crossCheck,
          priorReview: priorReview ?? null,
        });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    }
  );

  // The tax computation working paper — reviewed by the preparer BEFORE the
  // return is filled. Same deterministic inputs as /generate, no file writes.
  app.post('/api/session/:id/computation', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    try {
      const { rules, answers, excluded } = req.body as {
        rules: MappingRule[];
        answers: Record<string, number>;
        excluded: string[];
      };
      const fill = applyMapping(
        session.accounts.filter((a) => !(excluded ?? []).includes(a.accountCode)),
        { rules: rules ?? [] }
      );
      if (fill.unmappedAccounts.length) {
        return res.status(400).json({
          error: `unmapped accounts remain: ${fill.unmappedAccounts.map((u) => u.code).join(', ')} — map or exclude each one`,
        });
      }
      res.json({ computation: computeTax(netProfitFromMapping(fill), answers ?? {}) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Advisory AI reasonableness review of the draft computation (same inputs as
  // /computation). Never writes figures, never gates generation; env-gated —
  // returns available:false when no API key is configured.
  app.post('/api/session/:id/review', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    try {
      const { rules, answers, excluded } = req.body as {
        rules: MappingRule[];
        answers: Record<string, number>;
        excluded: string[];
      };
      const included = session.accounts.filter((a) => !(excluded ?? []).includes(a.accountCode));
      const fill = applyMapping(included, { rules: rules ?? [] });
      if (fill.unmappedAccounts.length) {
        return res.status(400).json({
          error: `unmapped accounts remain: ${fill.unmappedAccounts.map((u) => u.code).join(', ')} — map or exclude each one`,
        });
      }
      const computation = computeTax(netProfitFromMapping(fill), answers ?? {});
      res.json({ review: await reasonablenessReview(included, computation) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post('/api/session/:id/generate', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    try {
      const { rules, answers, clientName, yearOfAssessment, excluded, priorReviewAcknowledged } = req.body as {
        rules: MappingRule[];
        answers: Record<string, number>;
        clientName: string;
        yearOfAssessment: string;
        excluded: string[];
        priorReviewAcknowledged?: boolean;
      };

      // Prior-year return review gate: errors found on the prior return must be
      // explicitly acknowledged by the preparer before generation proceeds.
      const priorErrors = session.priorReview?.findings.filter((f) => f.severity === 'error') ?? [];
      if (priorErrors.length > 0 && priorReviewAcknowledged !== true) {
        return res.status(400).json({
          error:
            `Generation blocked: the prior-year return review found ${priorErrors.length} error(s) — ` +
            `acknowledge the prior-year return review findings before generating, or re-upload/omit the prior return.`,
        });
      }

      // Credit gate — each generated return costs one free-return credit.
      const uid = res.locals.userId as string;
      if (!OPEN) {
        const me = currentUser(cookieToken(req));
        if (!me || me.credits < 1) {
          return res.status(402).json({
            error: 'You have no free returns left. Contact us at info@vacei.com to add more.',
          });
        }
      }

      const profile: MappingProfile = { rules: rules ?? [] };
      const fill = applyMapping(
        session.accounts.filter((a) => !(excluded ?? []).includes(a.accountCode)),
        profile
      );
      if (fill.unmappedAccounts.length) {
        return res.status(400).json({
          error: `unmapped accounts remain: ${fill.unmappedAccounts.map((u) => u.code).join(', ')} — map or exclude each one`,
        });
      }
      const netProfit = netProfitFromMapping(fill);
      const interviewFills = fillsFromAnswers(answers ?? {});
      const directCells = [...fill.directCells];
      for (const f of interviewFills) {
        if (f.anchorId && ANCHORS[f.anchorId]) {
          const a = ANCHORS[f.anchorId]!;
          directCells.push({ sheet: a.sheet, ref: a.ref, value: a.negate ? -Math.abs(f.amount) : f.amount });
          if (a.labelRef) directCells.push({ sheet: a.sheet, ref: a.labelRef, value: f.label });
        }
      }
      const { buffer, unmatched } = await fillCfrReturn(session.template, fill.codeCells, directCells);

      const tie =
        session.fsFigures &&
        tieCheck(session.fsFigures, {
          netProfit,
          // Asset-class codes only (sub-3000, consistent with prior-return.ts);
          // let signs net so contra-assets reduce the total and positive-balance
          // equity/liability codes (>=3000) are not miscounted as assets.
          totalAssets: fill.codeCells
            .filter((c) => c.sheet === 'B_Sheet' && c.cfrCode < 3000)
            .reduce((a, c) => a + c.amount, 0),
        });

      const priorReviewWarnings = (session.priorReview?.findings ?? []).map(
        (f) => `Prior-year return review (${f.severity}): ${f.message}`
      );

      const comp = computeTax(netProfit, answers ?? {});
      const summary = renderComputationSummary({
        clientName: clientName || 'Client',
        yearOfAssessment: yearOfAssessment || '',
        netProfitPerAccounts: netProfit,
        computation: comp,
        fills: interviewFills,
        mappingRows: session.accounts
          .filter((a) => fill.applied.has(a.accountCode))
          .map((a) => {
            const r = fill.applied.get(a.accountCode)!;
            return { ledger: `${a.accountCode} ${a.accountName}`, cfrCode: r.cfrCode, sheet: r.sheet, amount: a.cyBalance };
          }),
        warnings: [...session.warnings, ...priorReviewWarnings, ...(tie && !tie.ok ? tie.issues : [])],
        unmatchedCodes: unmatched,
      });

      session.output = { xlsx: buffer, summary };

      // Persist the return + spend a credit (production only; OPEN mode skips
      // both so tests don't touch disk or need real users).
      let returnId: string | null = null;
      let creditsLeft: number | null = null;
      if (!OPEN) {
        consumeCredit(uid);
        returnId = crypto.randomUUID();
        saveReturn(
          {
            id: returnId,
            userId: uid,
            clientName: clientName || 'Client',
            ya: yearOfAssessment || '',
            taxCharge: comp.taxCharge,
            createdAt: new Date().toISOString(),
          },
          buffer,
          summary
        );
        creditsLeft = currentUser(cookieToken(req))?.credits ?? null;
      }

      // Best-effort admin notification (no-op unless SMTP is configured).
      void notifyAdmin(
        'Malta Tax AI — return generated',
        `A tax return was generated on tax.vacei.com:\n\n  Client: ${clientName || '(unnamed)'}\n  Year of assessment: ${yearOfAssessment || '(unspecified)'}\n  Net profit per accounts: ${netProfit.toFixed(2)}`
      );
      res.json({ downloadReady: true, unmatched, tie: tie ?? null, returnId, credits: creditsLeft });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.get('/api/session/:id/return.xlsx', (req, res) => {
    const out = sessions.get(req.params.id)?.output;
    if (!out) return res.status(404).json({ error: 'not generated yet' });
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', 'attachment; filename="tax-return-filled.xlsx"')
      .send(out.xlsx);
  });

  app.get('/api/session/:id/summary.html', (req, res) => {
    const out = sessions.get(req.params.id)?.output;
    if (!out) return res.status(404).json({ error: 'not generated yet' });
    res.type('html').send(out.summary);
  });

  // `extensions: ['html']` lets /login, /dashboard, /new-return resolve to the
  // corresponding .html files; / serves index.html (the marketing homepage).
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // Multer throws (oversized upload > 60MB, unexpected field, etc.) from the
  // upload.fields middleware BEFORE any route try/catch runs. Without this
  // 4-arg error handler those errors reach Express's default handler and become
  // a plain-text 500, breaking the JSON {error} contract every client relies on.
  // Translate MulterError (and any error that reaches here) into a 400 JSON.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4380);
  createApp().listen(port, () => console.log(`Tax Return Generator on http://localhost:${port}`));
}
