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
import { fillCfrReturn } from './template-writer';
import { renderComputationSummary } from './computation-summary';
import { ANCHORS } from './template-map';

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
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });
  const sessions = new Map<string, Session>();

  // ---- Shared-credential auth gate ----
  // Active only when APP_PASSWORD is set (so local dev + tests run open). Protects
  // the app pages and every tax API route with an HMAC-signed, httpOnly cookie.
  const AUTH_USER = process.env.APP_USER || 'admin';
  const AUTH_PASS = process.env.APP_PASSWORD || '';
  const AUTH_ENABLED = AUTH_PASS.length > 0;
  const AUTH_SECRET = process.env.SESSION_SECRET || `${AUTH_USER}:${AUTH_PASS}`;
  const signExp = (v: string) => crypto.createHmac('sha256', AUTH_SECRET).update(v).digest('hex');
  const makeToken = () => {
    const exp = String(Date.now() + 12 * 3600 * 1000);
    return `${exp}.${signExp(exp)}`;
  };
  const tokenValid = (t: string | undefined): boolean => {
    if (!t) return false;
    const i = t.indexOf('.');
    if (i < 0) return false;
    const exp = t.slice(0, i);
    const mac = t.slice(i + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    const good = signExp(exp);
    return good.length === mac.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(mac));
  };
  const isAuthed = (req: express.Request): boolean => {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)mt_auth=([^;]+)/);
    return m ? tokenValid(decodeURIComponent(m[1])) : false;
  };
  const eqConst = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };
  const PROTECTED_PAGES = new Set(['/new-return', '/new-return.html', '/dashboard', '/dashboard.html']);

  app.post('/api/login', (req, res) => {
    if (!AUTH_ENABLED) return res.json({ ok: true });
    const { user, password } = (req.body || {}) as { user?: string; password?: string };
    const ok =
      typeof user === 'string' &&
      typeof password === 'string' &&
      eqConst(user, AUTH_USER) &&
      eqConst(password, AUTH_PASS);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    res.setHeader(
      'Set-Cookie',
      `mt_auth=${makeToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${12 * 3600}`
    );
    res.json({ ok: true });
  });
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'mt_auth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  if (AUTH_ENABLED) {
    app.use((req, res, next) => {
      const p = req.path;
      const isApi = p.startsWith('/api/');
      const isAuthApi = p === '/api/login' || p === '/api/logout';
      const needsAuth = PROTECTED_PAGES.has(p) || (isApi && !isAuthApi);
      if (!needsAuth || isAuthed(req)) return next();
      if (isApi) return res.status(401).json({ error: 'not authenticated' });
      return res.redirect('/login');
    });
  }

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

      const summary = renderComputationSummary({
        clientName: clientName || 'Client',
        yearOfAssessment: yearOfAssessment || '',
        netProfitPerAccounts: netProfit,
        computation: computeTax(netProfit, answers ?? {}),
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
      res.json({ downloadReady: true, unmatched, tie: tie ?? null });
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
