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
import { extractFsFiguresAny, tieCheck, type FsFigures } from './fs-tie-check';
import {
  readPriorReturn,
  priorYearCrossCheck,
  reviewPriorReturn,
  priorLossesCarriedForward,
  priorUnabsorbedCapitalAllowancesCf,
  priorTaxAccountAllocations,
  type PriorReturnReview,
} from './prior-return';
import { proposeMappingAI } from './ai-mapper';
import { applyMapping, netProfitFromMapping, deriveSectionTotals, TOTAL_CODE_KEYS, sheetAllowed } from './mapping';
import { recallMapping, rememberMapping } from './mapping-memory';
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
  grantCredits,
  bootstrapAdmin,
} from './accounts';
import { saveReturn, listReturns, findReturn, returnFilePath } from './store';
import { readTemplateCodes, codeKeySet, type TemplateCode } from './template-codes';
import { readCfrValues } from './template-reader';

interface Session {
  accounts: EtbAccount[];
  warnings: string[];
  template: Buffer;
  /** Data-entry code rows that exist in the uploaded template (mapping is constrained to these). */
  templateCodes: TemplateCode[];
  codeKeys: Set<string>;
  prior?: { codes: Set<number> };
  priorBuffer?: Buffer;
  priorReview?: PriorReturnReview;
  fsFigures?: FsFigures;
  output?: { xlsx: Buffer; summary: string };
  /** Client name of the remembered mapping this session was recognised as. */
  recalledFrom?: string | null;
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
    // ETB/template/prior must be spreadsheets (the template IS a spreadsheet
    // and the ETB needs tabular data). Financial statements are advisory-only
    // input, so accept whatever firms actually have — mainly PDFs.
    fileFilter: (_req, file, cb) => {
      const name = file.originalname || '';
      if (file.fieldname === 'fs') {
        if (/\.(pdf|xlsx|xls|xlsm|csv|txt|docx?|odt|ods)$/i.test(name)) return cb(null, true);
        return cb(
          new Error(`Unsupported financial statements file "${name}" — upload a PDF, Excel, Word or CSV file`)
        );
      }
      if (/\.(xlsx|xls|xlsm)$/i.test(name)) return cb(null, true);
      cb(new Error(`Unsupported file type "${name}" — upload .xlsx, .xls or .xlsm`));
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
    '/terms', '/terms.html',
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

  // Manual sales flow: the ADMIN_EMAIL account grants purchased credits
  // (bank transfer / invoice today; Stripe later). Non-admins get 403.
  app.post('/api/admin/grant', (req, res) => {
    const u = currentUser(cookieToken(req));
    if (!u) return res.status(401).json({ error: 'not authenticated' });
    const { email, credits } = (req.body || {}) as { email?: string; credits?: number };
    const balance = grantCredits(u.email, email || '', Number(credits));
    if (balance === null) return res.status(403).json({ error: 'not permitted, unknown user, or invalid amount' });
    void notifyAdmin('Malta Tax AI — credits granted', `${u.email} granted ${credits} credits to ${email} (new balance ${balance}).`);
    res.json({ ok: true, email, credits: balance });
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
    const filePath = returnFilePath(row.id, ext);
    if (!filePath) return res.status(404).json({ error: 'not found' });
    // Stream from disk (res.sendFile) — Render's HTTP/2 proxy 503s on a large
    // res.send(buffer), but streams a file correctly.
    if (ext === 'xlsx') {
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="tax-return-filled.xlsx"');
    } else {
      res.type('html');
    }
    res.sendFile(filePath);
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

        // Read the template's real data-entry rows FIRST — a wrong file here is
        // the express route to a silently empty return.
        const templateCodes = readTemplateCodes(tplFile.buffer);
        if (templateCodes.length === 0) {
          return res.status(400).json({
            error:
              'The template file does not look like a CfR e-return — no B_Sheet/Income code rows were found. Upload the official CfR corporate return template (.xlsx/.xlsm).',
          });
        }

        const parsed = parseEtb(etbFile.buffer);
        const warnings = [...parsed.warnings];
        const session: Session = {
          accounts: parsed.accounts,
          warnings,
          template: tplFile.buffer,
          templateCodes,
          codeKeys: codeKeySet(templateCodes),
        };

        if (files?.fs?.[0]) {
          const fsRes = await extractFsFiguresAny(files.fs[0].buffer, files.fs[0].originalname || 'fs');
          session.fsFigures = fsRes.figures;
          if (fsRes.note) warnings.push(fsRes.note);
        }
        let priorCodes: Set<number> | undefined;
        let priorValues: Map<string, number> | undefined;
        let priorReview: PriorReturnReview | undefined;
        if (files?.prior?.[0]) {
          session.priorBuffer = files.prior[0].buffer;
          // Review-first gate: run BEFORE the prior return is used as a basis for anything.
          priorReview = await reviewPriorReturn(files.prior[0].buffer);
          session.priorReview = priorReview;
          const info = await readPriorReturn(files.prior[0].buffer);
          priorCodes = info.codes;
          priorValues = new Map(
            info.values
              .filter((v) => v.value !== null && !v.computed && Math.abs(v.value as number) > 0.5)
              .map((v) => [`${v.sheet}:${v.cfrCode}`, v.value as number])
          );
          session.prior = { codes: info.codes };
        }

        const proposal = await proposeMappingAI(parsed.accounts, {
          priorYearCodes: priorCodes,
          priorYearValues: priorValues,
          templateCodes,
        });
        // FLYWHEEL RECALL: a returning client (recognised by ledger-code
        // overlap) opens with the firm's own previously CONFIRMED mapping —
        // it overrides model proposals for the accounts it knows. Template
        // validity and statement routing still apply.
        const owner = currentUser(cookieToken(req))?.email ?? 'shared';
        const recalled = recallMapping(owner, parsed.accounts);
        let recalledFrom: string | null = null;
        if (recalled) {
          recalledFrom = recalled.clientName;
          const validKeys = new Set(templateCodes.map((c) => `${c.sheet}:${c.code}`));
          const accByCode = new Map(parsed.accounts.map((a) => [a.accountCode, a]));
          const byLedger = new Map(proposal.rules.map((r) => [r.ledgerCode, r]));
          for (const r of recalled.rules) {
            if (!validKeys.has(`${r.sheet}:${r.cfrCode}`)) continue;
            if (!sheetAllowed(accByCode.get(r.ledgerCode) ?? {}, r.sheet)) continue;
            byLedger.set(r.ledgerCode, r);
          }
          proposal.rules = [...byLedger.values()];
        }
        session.recalledFrom = recalledFrom;
        const interview = buildInterview(parsed.accounts, {
          hasPriorReturn: !!priorCodes,
          priorLossesBroughtForward: session.priorBuffer
            ? priorLossesCarriedForward(session.priorBuffer)
            : null,
          priorUnabsorbedCaBf: session.priorBuffer
            ? priorUnabsorbedCapitalAllowancesCf(session.priorBuffer)
            : null,
        });
        // Prior-year tax-account allocations (drives shareholder refund
        // entitlement) — surfaced as review context, read-only.
        if (session.priorBuffer && priorReview) {
          const alloc = priorTaxAccountAllocations(session.priorBuffer);
          if (alloc && Math.abs(alloc.total) > 0.5) {
            priorReview.findings.push({
              severity: 'warning',
              message:
                `Prior-year return allocated €${alloc.total.toFixed(2)} of income to the tax accounts ` +
                `(${alloc.nonZero} account${alloc.nonZero === 1 ? '' : 's'}). Check the FTA/IPA/MTA/UA split on p6 ` +
                `when advising on shareholder refund claims (6/7, 5/7, 2/3) this year.`,
            });
          }
        }

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
          // The UI constrains the CfR-code pickers to these real template rows.
          templateCodes,
          // Returning client recognised by ledger overlap — mapping replayed
          // from the firm's own confirmed history.
          recalledFrom,
        });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    }
  );

  /**
   * Every confirmed rule must target a code row that exists in THIS template —
   * otherwise the write lands nowhere and that section of the return stays
   * empty. Returns a user-actionable error string, or null when all valid.
   */
  const invalidRuleError = (session: Session, rules: MappingRule[]): string | null => {
    const bad = (rules ?? []).filter(
      (r) => typeof r.cfrCode === 'number' && !session.codeKeys.has(`${r.sheet}:${r.cfrCode}`)
    );
    if (!bad.length) return null;
    const list = [...new Set(bad.map((r) => `${r.cfrCode} (${r.sheet})`))].slice(0, 12).join(', ');
    return `These CfR codes are not lines on this template: ${list} — pick codes from the template's list before continuing.`;
  };

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
      const badCode = invalidRuleError(session, rules ?? []);
      if (badCode) return res.status(400).json({ error: badCode });
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
      const badCode = invalidRuleError(session, rules ?? []);
      if (badCode) return res.status(400).json({ error: badCode });
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

      const badCode = invalidRuleError(session, rules ?? []);
      if (badCode) return res.status(400).json({ error: badCode });

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
      // Section totals (TOTAL REVENUE/ASSETS/…) are typed inputs on the firm's
      // returns — derive them arithmetically, but ONLY for rows this template
      // carries as non-formula inputs (a self-computing template is never
      // overwritten). Derived from the pre-total cells; aggregates below
      // exclude them via TOTAL_CODE_KEYS.
      const templateVals = await readCfrValues(session.template, ['B_Sheet', 'Income']);
      const writableTotals = new Set(
        templateVals
          .filter((v) => !v.computed && TOTAL_CODE_KEYS.has(`${v.sheet}:${v.cfrCode}`))
          .map((v) => `${v.sheet}:${v.cfrCode}`)
      );
      const allCells = [...fill.codeCells, ...deriveSectionTotals(fill.codeCells, writableTotals)];
      const { buffer, unmatched } = await fillCfrReturn(session.template, allCells, directCells);
      // Belt-and-braces: rules were validated against the template, so nothing
      // may be unmatched. If it is, the output is incomplete — refuse to ship it.
      if (unmatched.length) {
        return res.status(400).json({
          error: `Generation stopped: ${unmatched.length} value(s) had no matching row in the template (${unmatched
            .map((u) => `${u.sheet}/${u.cfrCode}`)
            .join(', ')}). Fix the mapping and try again.`,
        });
      }

      // VERIFICATION PASS: re-read the workbook we just produced and confirm
      // every mapped figure actually landed on its code row. A return only
      // ships if 100% of intended writes are present and exact.
      const written = await readCfrValues(buffer, ['B_Sheet', 'Income']);
      const writtenByKey = new Map(written.map((w) => [`${w.sheet}:${w.cfrCode}`, w.value]));
      const missing = allCells.filter((c) => {
        const v = writtenByKey.get(`${c.sheet}:${c.cfrCode}`);
        return v === null || v === undefined || Math.abs(v - c.amount) > 0.01;
      });
      if (missing.length) {
        return res.status(500).json({
          error: `Verification failed: ${missing.length} value(s) did not land in the generated file (${missing
            .map((m) => `${m.sheet}/${m.cfrCode}`)
            .join(', ')}). The return was NOT produced — please report this.`,
        });
      }
      const verification = {
        accountsIncluded: fill.applied.size,
        codeRowsWritten: allCells.length,
        allWritesVerified: true,
      };

      const sumCells = (sheet: string, lo: number, hi: number) =>
        fill.codeCells.filter((c) => c.sheet === sheet && c.cfrCode >= lo && c.cfrCode <= hi).reduce((a, c) => a + c.amount, 0);
      const tie =
        session.fsFigures &&
        tieCheck(session.fsFigures, {
          netProfit,
          // Asset-class codes only (sub-3000, consistent with prior-return.ts);
          // let signs net so contra-assets reduce the total and positive-balance
          // equity/liability codes (>=3000) are not miscounted as assets.
          totalAssets: sumCells('B_Sheet', 0, 2999),
          // Line-by-line ties (magnitude-compared in tieCheck): revenue block
          // 5000-5499, liabilities 3000-3799, equity 3800-3998.
          revenue: sumCells('Income', 5000, 5499) || null,
          totalLiabilities: sumCells('B_Sheet', 3000, 3799) || null,
          totalEquity: sumCells('B_Sheet', 3800, 3998) || null,
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

      // FLYWHEEL REMEMBER: the preparer just CONFIRMED this mapping by
      // generating — persist it per client so next year opens pre-mapped.
      try {
        const nameByCode = new Map(session.accounts.map((a) => [a.accountCode, a.accountName]));
        rememberMapping(
          currentUser(cookieToken(req))?.email ?? 'shared',
          clientName || 'Client',
          yearOfAssessment || '',
          (rules ?? [])
            .filter((r: MappingRule): r is MappingRule & { ledgerCode: string } => !!r.ledgerCode)
            .map((r) => ({
              ledgerCode: r.ledgerCode,
              ledgerName: nameByCode.get(r.ledgerCode) ?? '',
              cfrCode: r.cfrCode,
              sheet: r.sheet,
            }))
        );
      } catch (e) {
        console.warn('[mapping-memory] remember failed:', (e as Error).message);
      }

      // Best-effort admin notification (no-op unless SMTP is configured).
      void notifyAdmin(
        'Malta Tax AI — return generated',
        `A tax return was generated on tax.vacei.com:\n\n  Client: ${clientName || '(unnamed)'}\n  Year of assessment: ${yearOfAssessment || '(unspecified)'}\n  Net profit per accounts: ${netProfit.toFixed(2)}`
      );
      res.json({ downloadReady: true, unmatched, tie: tie ?? null, returnId, credits: creditsLeft, verification });
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
