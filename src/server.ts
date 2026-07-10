/**
 * Standalone web app: upload ETB + FS + blank CfR template (+ prior return),
 * confirm mapping + interview, download filled return + computation summary.
 * Sessions are in-memory (single-workstation tool, v1).
 */
import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
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
import { applyMapping, netProfitFromMapping, deriveSectionTotals, applyClosingEntry, TOTAL_CODE_KEYS, sheetAllowed } from './mapping';
import { recallMapping, rememberMapping, seedFromRepoIfEmpty } from './mapping-memory';
import { buildInterview, fillsFromAnswers } from './interview';
import { computeTax } from './tax-computation';
import { computeRefund, type RefundCategory } from './refund-computation';
import { computeNid } from './nid-computation';
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
import { saveReturn, listReturns, findReturn, returnFilePath, returnSessionDir } from './store';
import { readTemplateCodes, codeKeySet, type TemplateCode } from './template-codes';
import { readCfrValues } from './template-reader';
import {
  detectTemplateVersion,
  loadStoredBlank,
  requiredCellRefs,
  declarationCells,
  interestExpenseTotal,
  readCompanyIdentity,
  liftRegistrationFromPrior,
} from './firm-defaults';

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
  /** Detected CfR template vintage (e.g. "TA2_e-CO_2025_Ver 1.1"). */
  templateVersion?: string | null;
  /** Company identity lifted from the prior return (UI pre-fill). */
  priorIdentity?: { tin: string | null; name: string | null };
}

export function createApp() {
  bootstrapAdmin(); // create the env-configured admin account if missing (idempotent)
  seedFromRepoIfEmpty(); // flywheel: corpus-learned mappings onto a fresh data disk (idempotent)
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

  // Sessions survive a redeploy/restart: the parsed state + uploaded buffers
  // are persisted at creation and lazily rehydrated on the first lookup after
  // a restart. Mid-return "session not found" (tester-reported) was caused by
  // deploys wiping the in-memory map while a preparer was on Step 2.
  const SESS_DIR = path.join(process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data')), 'sessions');
  fs.mkdirSync(SESS_DIR, { recursive: true });
  // Ephemeral by design: sweep sessions older than 48h on boot.
  for (const d of fs.readdirSync(SESS_DIR)) {
    try {
      const st = fs.statSync(path.join(SESS_DIR, d));
      if (Date.now() - st.mtimeMs > 48 * 3600 * 1000) fs.rmSync(path.join(SESS_DIR, d), { recursive: true, force: true });
    } catch {
      /* sweep is best-effort */
    }
  }
  function persistSession(id: string, s: Session): void {
    try {
      const dir = path.join(SESS_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'template.xlsx'), s.template);
      if (s.priorBuffer) fs.writeFileSync(path.join(dir, 'prior.xlsx'), s.priorBuffer);
      fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({
          accounts: s.accounts,
          warnings: s.warnings,
          templateCodes: s.templateCodes,
          priorReview: s.priorReview ?? null,
          fsFigures: s.fsFigures ?? null,
          recalledFrom: s.recalledFrom ?? null,
          templateVersion: s.templateVersion ?? null,
          priorIdentity: s.priorIdentity ?? null,
        })
      );
    } catch (e) {
      console.warn('[sessions] persist failed:', (e as Error).message);
    }
  }
  async function rehydrateFrom(dir: string): Promise<Session | undefined> {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      const template = fs.readFileSync(path.join(dir, 'template.xlsx'));
      const priorBuffer = fs.existsSync(path.join(dir, 'prior.xlsx')) ? fs.readFileSync(path.join(dir, 'prior.xlsx')) : undefined;
      const s: Session = {
        accounts: state.accounts,
        warnings: state.warnings,
        template,
        templateCodes: state.templateCodes,
        codeKeys: new Set((state.templateCodes as TemplateCode[]).map((c) => `${c.sheet}:${c.code}`)),
        priorBuffer,
        prior: priorBuffer ? { codes: (await readPriorReturn(priorBuffer)).codes } : undefined,
        priorReview: state.priorReview ?? undefined,
        fsFigures: state.fsFigures ?? undefined,
        recalledFrom: state.recalledFrom ?? null,
        templateVersion: state.templateVersion ?? null,
        priorIdentity: state.priorIdentity ?? undefined,
      };
      return s;
    } catch {
      return undefined;
    }
  }
  async function getSession(id: string): Promise<Session | undefined> {
    const inMem = sessions.get(id);
    if (inMem) return inMem;
    // Rehydrate from disk (post-restart).
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const s = await rehydrateFrom(path.join(SESS_DIR, id));
    if (s) sessions.set(id, s);
    return s;
  }

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
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    res.json({
      email: u.email,
      firm: u.firm,
      credits: u.credits,
      emailVerified: u.emailVerified,
      isAdmin: !!adminEmail && u.email.toLowerCase() === adminEmail,
    });
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

  // REOPEN a generated return for editing: rebuild a working session from the
  // return's durable session snapshot (falling back to the original session
  // dir for pre-snapshot returns) and hand back the preparer's confirmed
  // rules/answers — Step 2, exactly where they left off. No AI, no credit.
  app.post('/api/returns/:id/reopen', async (req, res) => {
    const row = findReturn(req.params.id);
    if (!row || row.userId !== res.locals.userId) return res.status(404).json({ error: 'not found' });
    const session = await rehydrateFrom(returnSessionDir(row.id));
    if (!session) {
      return res.status(410).json({
        error:
          'The source files for this return are no longer stored (generated before reopening existed) — start a new return with the same uploads instead.',
      });
    }
    const interview = buildInterview(session.accounts, {
      hasPriorReturn: !!session.priorBuffer,
      priorLossesBroughtForward: session.priorBuffer ? priorLossesCarriedForward(session.priorBuffer) : null,
      priorUnabsorbedCaBf: session.priorBuffer ? priorUnabsorbedCapitalAllowancesCf(session.priorBuffer) : null,
    });
    const id = crypto.randomUUID();
    sessions.set(id, session);
    persistSession(id, session);
    res.json({
      sessionId: id,
      accounts: session.accounts,
      proposal: { source: 'saved', rules: row.inputs?.rules ?? [] },
      interview,
      warnings: session.warnings,
      fsFigures: session.fsFigures ?? null,
      crossCheck: null,
      priorReview: session.priorReview ?? null,
      templateCodes: session.templateCodes,
      recalledFrom: null,
      templateVersion: session.templateVersion ?? null,
      priorIdentity: session.priorIdentity ?? null,
      savedInputs: row.inputs ?? null,
    });
  });

  app.post(
    '/api/session',
    upload.fields([
      { name: 'etb', maxCount: 1 },
      { name: 'fs', maxCount: 1 },
      { name: 'template', maxCount: 1 },
      { name: 'prior', maxCount: 1 },
    ]),
    async (req, res) => {
      // Stage telemetry for the live upload path — the 2026-07-07 outage hung
      // this route with zero app logs, leaving nothing to localise the stall.
      const t0 = Date.now();
      const stage = (name: string) => console.info(`[session] +${Date.now() - t0}ms ${name}`);
      try {
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const etbFile = files?.etb?.[0];
        const tplFile = files?.template?.[0];
        stage(`files received (etb=${etbFile?.size ?? 0}b tpl=${tplFile?.size ?? 0}b prior=${files?.prior?.[0]?.size ?? 0}b)`);
        if (!etbFile || !tplFile) return res.status(400).json({ error: 'etb and template files are required' });

        // SWAP-TO-BLANK: preparers routinely upload a USED return (any
        // client's) as the "template". When its vintage matches a verified
        // blank we ship, use the blank instead — every stale figure, flag,
        // name and TIN from the donor file is gone by construction.
        let templateBuffer = tplFile.buffer;
        const templateVersion = await detectTemplateVersion(templateBuffer);
        const swapWarnings: string[] = [];
        if (templateVersion) {
          const blank = loadStoredBlank(templateVersion);
          if (blank) {
            templateBuffer = blank;
            swapWarnings.push(
              `Template recognised as ${templateVersion} — generated on a verified blank copy of the official template. ` +
                `Any figures or answers left in the uploaded file were ignored.`
            );
          } else {
            swapWarnings.push(
              `Template vintage ${templateVersion} is not in the verified-blank library — values typed outside the ` +
                `account rows are NOT auto-cleared. Make sure the uploaded template is blank.`
            );
          }
        }
        stage(`template version ${templateVersion ?? 'unknown'}${templateBuffer !== tplFile.buffer ? ' (swapped to stored blank)' : ''}`);

        // Read the template's real data-entry rows FIRST — a wrong file here is
        // the express route to a silently empty return.
        const templateCodes = readTemplateCodes(templateBuffer);
        if (templateCodes.length === 0) {
          return res.status(400).json({
            error:
              'The template file does not look like a CfR e-return — no B_Sheet/Income code rows were found. Upload the official CfR corporate return template (.xlsx/.xlsm).',
          });
        }

        stage(`template codes read (${templateCodes.length})`);
        const parsed = parseEtb(etbFile.buffer);
        stage(`etb parsed (${parsed.accounts.length} accounts)`);
        const warnings = [...swapWarnings, ...parsed.warnings];
        const session: Session = {
          accounts: parsed.accounts,
          warnings,
          template: templateBuffer,
          templateCodes,
          codeKeys: codeKeySet(templateCodes),
          templateVersion,
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
          // The client's identity carries over from the prior filing — lift it
          // so the preparer doesn't retype (and the new return can't ship with
          // the donor template's name/TIN).
          session.priorIdentity = await readCompanyIdentity(files.prior[0].buffer);
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
        stage('prior reviewed/read');

        // FLYWHEEL RECALL: recognise a returning client by ledger-code overlap
        // FIRST, so we can choose the mapping engine. A recognised client maps
        // DETERMINISTICALLY — heuristic base (identical every run) with the
        // firm's confirmed history layered on top — skipping the AI call, which
        // is non-deterministic (same client, different sub-line placement run to
        // run), slow (~2 min) and paid. AI variance now only touches genuinely
        // new clients; the return a preparer sees for a known client is stable.
        const owner = currentUser(cookieToken(req))?.email ?? 'shared';
        const recalled = recallMapping(owner, parsed.accounts);
        const proposal = await proposeMappingAI(
          parsed.accounts,
          { priorYearCodes: priorCodes, priorYearValues: priorValues, templateCodes },
          { disableAi: !!recalled }
        );
        stage(`mapping proposed (source=${proposal.source}, rules=${proposal.rules.length}, recognised=${!!recalled})`);
        // Template validity and statement routing still apply to recalled rules.
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
        persistSession(id, session);
        stage('cross-checked + persisted — responding');
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
          templateVersion,
          priorIdentity: session.priorIdentity ?? null,
        });
      } catch (e) {
        stage(`FAILED: ${(e as Error).message}`);
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
  app.post('/api/session/:id/computation', async (req, res) => {
    const session = await getSession(req.params.id);
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
    const session = await getSession(req.params.id);
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
    const session = await getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    try {
      const { rules, answers, clientName, companyTin, yearOfAssessment, excluded, priorReviewAcknowledged } = req.body as {
        rules: MappingRule[];
        answers: Record<string, number>;
        clientName: string;
        companyTin?: string;
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
      const comp = computeTax(netProfit, answers ?? {});
      const interviewFills = fillsFromAnswers(answers ?? {});
      const directCells = [...fill.directCells];

      // Company identity + the firm's standing declarations (attachment-
      // complete flags, p2 questionnaire, refund-by-cheque, ATAD TRA111).
      // Deterministic writes, each listed for the preparer; constrained to
      // the refs THIS template's own "Required!" markers declare mandatory.
      const included = session.accounts.filter((a) => !(excluded ?? []).includes(a.accountCode));
      const { required, requiredOrZero, sheets } = await requiredCellRefs(session.template);
      const decl = declarationCells({
        required,
        sheets,
        companyName: clientName || session.priorIdentity?.name || undefined,
        companyTin: companyTin || session.priorIdentity?.tin || undefined,
        interestExpense: interestExpenseTotal(included),
        answers: answers ?? {},
      });
      directCells.push(...decl.cells);
      if (!(companyTin || session.priorIdentity?.tin)) {
        decl.notes.push(
          'No taxpayer reference (TIN) was provided — p1 was left without it. Enter the income tax number before submitting.'
        );
      }
      // Registration data carried over from the prior filing (p1 details,
      // p7 shareholder register, p8 signatory) — a shareholder change is
      // declared via the p2 G91–G94 questions, not silently re-derived.
      if (session.priorBuffer) {
        const lifted = await liftRegistrationFromPrior(session.priorBuffer, sheets);
        directCells.push(...lifted.cells);
        decl.notes.push(...lifted.notes);
      }
      // p8 declaration date — the FS board-approval date when financial
      // statements were uploaded (Excel serial; the cell's date style is
      // preserved by the writer). The preparer adjusts it if the return is
      // signed on a different day.
      if (sheets.has('p8') && session.fsFigures?.approvalDate) {
        const [y, mo, d] = session.fsFigures.approvalDate.split('-').map(Number);
        const serial = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
        directCells.push({ sheet: 'p8', ref: 'U37', value: serial });
        decl.notes.push(
          `p8: declaration date ${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y} — taken from the financial statements' board-approval date; change it if the return is signed on a different day`
        );
      }
      const writtenAnchorRefs = new Set<string>();
      for (const f of interviewFills) {
        if (f.anchorId && ANCHORS[f.anchorId]) {
          const a = ANCHORS[f.anchorId]!;
          directCells.push({ sheet: a.sheet, ref: a.ref, value: a.negate ? -Math.abs(f.amount) : f.amount });
          writtenAnchorRefs.add(`${a.sheet}:${a.ref}`);
          if (a.labelRef) directCells.push({ sheet: a.sheet, ref: a.labelRef, value: f.label });
        }
      }
      // A zero/unconfirmed answer is dropped by fillsFromAnswers (never writes a
      // deliberate 0), so an anchor cell it would otherwise touch is left as-is —
      // fine on a genuinely blank template, but a REUSED prior-period file (a
      // real firm workflow: last year's filed return re-purposed as this year's
      // starting point) would leave that cell's stale prior-year figure sitting
      // untouched and silently wrong. Explicitly zero every other anchor cell.
      for (const [id, a] of Object.entries(ANCHORS)) {
        if (!a || id === 'netProfitPerAccounts') continue; // netProfitPerAccounts is always written above, unconditionally
        const key = `${a.sheet}:${a.ref}`;
        if (writtenAnchorRefs.has(key)) continue;
        directCells.push({ sheet: a.sheet, ref: a.ref, value: 0 });
      }
      // p3 fields 37a/37b/37c ("Allocated to Taxed Account": Immovable Property /
      // Maltese Taxed / Foreign Income) are a MANUAL entry the template never
      // computes itself (verified against real filed returns — E99/G99/I99 carry
      // literal values, not formulas), yet everything downstream (p4, p5, the
      // TRA61/62/63 tax-account totals) is fed from this row. Leaving it
      // unwritten means either a blank cross-check failure (CfR's own T100 check)
      // on a fresh template, or a stale figure surviving on a reused one — in
      // both cases the wrong number silently reaches the tax computation.
      // The preparer confirms the IPA (Malta immovable property) and FIA
      // (foreign-source) slices explicitly (propertyIncomeIPA/foreignSourceIncomeFIA
      // — never silently inferred from the ETB); whatever remains lands in the
      // Maltese Taxed Account, matching the standard-profile default when both
      // are 0.
      const ipa = answers?.['propertyIncomeIPA'] ?? 0;
      const fia = answers?.['foreignSourceIncomeFIA'] ?? 0;
      // A loss year has no meaningful split (there is no profit to allocate),
      // so the over-allocation check only applies when adjustedProfit is a
      // genuine profit — allocating more than 100% of it would silently
      // fabricate a wrong split rather than surface the preparer's mistake.
      if (comp.adjustedProfit >= 0 && ipa + fia > Math.abs(comp.adjustedProfit)) {
        return res.status(400).json({
          error:
            `IPA (€${ipa.toFixed(2)}) + FIA (€${fia.toFixed(2)}) allocation exceeds the adjusted profit ` +
            `(€${comp.adjustedProfit.toFixed(2)}) available to split across tax accounts on p3 row 99 — reduce the allocation.`,
        });
      }
      // A loss year allocates nothing to the taxed accounts (filed returns
      // carry 0/0/0 on row 99 — Northwind YA2024); only a profit is split.
      const mta = comp.adjustedProfit > 0 ? Math.round((comp.adjustedProfit - ipa - fia) * 100) / 100 : 0;
      directCells.push(
        { sheet: 'p3', ref: 'E99', value: comp.adjustedProfit > 0 ? ipa : 0 },
        { sheet: 'p3', ref: 'G99', value: mta },
        { sheet: 'p3', ref: 'I99', value: comp.adjustedProfit > 0 ? fia : 0 }
      );
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
      // Every non-formula data-entry row on this template — the only rows a
      // synthesized cell may be written to (a formula row would recompute and
      // fail the read-back check for no reason).
      const writableInputKeys = new Set(
        templateVals.filter((v) => !v.computed).map((v) => `${v.sheet}:${v.cfrCode}`)
      );
      // CORE cells are the preparer's actual account mappings (whole euros).
      // They are the return; they MUST land exactly or generation fails.
      const roundedCells = fill.codeCells.map((c) => ({ ...c, amount: Math.round(c.amount) }));
      const coreKeys = new Set(roundedCells.map((c) => `${c.sheet}:${c.cfrCode}`));
      // Closing entry (pre-closing ETBs: 3905 absorbs the year's result; RE b/f
      // and c/f rows 7501/7600 are added) + section totals. These are DERIVED
      // conveniences — a self-computing template legitimately overwrites them on
      // read-back — so they are best-effort: written only to writable input
      // rows, and never allowed to block or fail a valid return.
      const closedCells = applyClosingEntry(roundedCells, session.codeKeys);
      const core = closedCells.filter((c) => coreKeys.has(`${c.sheet}:${c.cfrCode}`));
      const derived = [
        ...closedCells.filter((c) => !coreKeys.has(`${c.sheet}:${c.cfrCode}`)),
        ...deriveSectionTotals(closedCells, writableTotals),
      ].filter((c) => writableInputKeys.has(`${c.sheet}:${c.cfrCode}`));
      const allCells = [...core, ...derived];

      // p6 reserves reconciliation ("Distributable profits" row): b/f and
      // year's movement as typed inputs; the sheet's own formulas roll the
      // c/f, tax-account rows and TOTAL RESERVES from these. Signs flip vs
      // the ETB (Dr accumulated losses → negative distributable profits).
      const re7501 = closedCells.find((c) => c.sheet === 'Income' && c.cfrCode === 7501)?.amount;
      const re7600 = closedCells.find((c) => c.sheet === 'Income' && c.cfrCode === 7600)?.amount;
      if (sheets.has('p6') && re7501 !== undefined && re7600 !== undefined) {
        directCells.push(
          { sheet: 'p6', ref: 'O32', value: -re7501 },
          { sheet: 'p6', ref: 'Q32', value: -(re7600 - re7501) }
        );
        decl.notes.push('p6: distributable profits brought forward + current-year movement (ties TOTAL RESERVES to the balance sheet)');
      }
      // p4 field 70b — unabsorbed trading losses carried forward (filed
      // returns carry it negative, like the 66b brought-forward row) — plus
      // the 66-row IPA/FIA side columns, 0 under the standard MTA-only
      // profile (see the lossesBroughtForward anchor note).
      if (sheets.has('p4')) {
        directCells.push(
          { sheet: 'p4', ref: 'O62', value: -Math.abs(comp.lossesCarriedForward ?? 0) },
          { sheet: 'p4', ref: 'K52', value: 0 },
          { sheet: 'p4', ref: 'R52', value: 0 }
        );
      }
      // NIL-YEAR ZERO BATTERY: the CfR e-return marks dozens of cells
      // "Required or insert 0!" (`reo` markers); on a nil year the firm types
      // 0 into every one (verified: Northwind YA2024). B_Sheet/Income are
      // excluded — their value column doubles as account code rows, and a
      // blind 0 could overwrite a mapped figure.
      const isNilYear = comp.taxCharge === 0 && comp.chargeableIncome <= 0 && ipa === 0 && fia === 0;
      const targeted = new Set(directCells.map((d) => `${d.sheet}!${d.ref}`));
      const zeroable = [...requiredOrZero].filter(
        (k) => !k.startsWith('B_Sheet!') && !k.startsWith('Income!') && !targeted.has(k)
      );
      if (isNilYear) {
        for (const k of zeroable) {
          const [sh, ref] = k.split('!');
          directCells.push({ sheet: sh, ref, value: 0 });
        }
        // p4 capital-allowance row 18 columns — typed 0 on nil-year filings
        // (not reo-marked on the sheet, so the battery misses them).
        if (sheets.has('p4')) {
          for (const ref of ['K18', 'O18', 'R18']) directCells.push({ sheet: 'p4', ref, value: 0 });
        }
        if (zeroable.length) decl.notes.push(`Nil year: 0 written into ${zeroable.length} "Required or insert 0!" cells across the return`);
      } else if (zeroable.length) {
        decl.notes.push(
          `${zeroable.length} "Required or insert 0!" cells were left for you (taxable year — several carry real figures): ` +
            zeroable.slice(0, 12).join(', ') + (zeroable.length > 12 ? ', …' : '')
        );
      }
      // STALE RESIDUE: typed values on input rows we are NOT writing (a
      // non-blank "template" — e.g. a prior-year filed return re-used as the
      // upload) would survive into the produced workbook and double-count
      // against the engine's figures. Blank them.
      const allKeys = new Set(allCells.map((c) => `${c.sheet}:${c.cfrCode}`));
      const staleRows = templateVals
        .filter((v) => !v.computed && v.value !== null && !allKeys.has(`${v.sheet}:${v.cfrCode}`))
        .map((v) => ({ sheet: v.sheet, cfrCode: v.cfrCode }));
      if (staleRows.length) {
        console.info(`[generate] non-blank template: clearing ${staleRows.length} stale typed value(s)`);
      }
      const { buffer, unmatched, failedDirect } = await fillCfrReturn(session.template, allCells, directCells, staleRows);
      // A zero-battery cell whose row isn't serialized is harmless (nothing
      // to zero); any OTHER direct write failing deserves a loud warning.
      const zeroableSet = new Set(zeroable);
      const importantFailures = failedDirect.filter((f) => !zeroableSet.has(`${f.sheet}!${f.ref}`));
      for (const f of importantFailures) {
        session.warnings.push(`Could not write ${f.sheet}!${f.ref} (${f.error}) — enter it on the return manually.`);
      }
      // A CORE mapped figure with no row on the template is a real error (rules
      // were validated, so this should never happen). An unmatched DERIVED cell
      // is harmless — the template computes that total itself — so ignore it.
      const coreUnmatched = unmatched.filter((u) => coreKeys.has(`${u.sheet}:${u.cfrCode}`));
      if (coreUnmatched.length) {
        return res.status(400).json({
          error: `Generation stopped: ${coreUnmatched.length} value(s) had no matching row in the template (${coreUnmatched
            .map((u) => `${u.sheet}/${u.cfrCode}`)
            .join(', ')}). Fix the mapping and try again.`,
        });
      }

      // VERIFICATION PASS: re-read the workbook we just produced and confirm
      // every CORE mapped figure actually landed on its code row. A return only
      // ships if 100% of the mapped account figures are present and exact.
      // Derived totals/closing rows are NOT verified fatally — a template that
      // computes a total itself overwrites our write on read-back, which is
      // correct, not a failure.
      const written = await readCfrValues(buffer, ['B_Sheet', 'Income']);
      const writtenByKey = new Map(written.map((w) => [`${w.sheet}:${w.cfrCode}`, w.value]));
      const missing = core.filter((c) => {
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
      // Stale rows must read back BLANK — a survivor would double-count
      // against the mapped figures the moment Excel recalculates.
      const staleSurvivors = staleRows.filter((s) => {
        const v = writtenByKey.get(`${s.sheet}:${s.cfrCode}`);
        return v !== null && v !== undefined;
      });
      if (staleSurvivors.length) {
        return res.status(500).json({
          error: `Verification failed: ${staleSurvivors.length} stale template value(s) survived clearing (${staleSurvivors
            .map((m) => `${m.sheet}/${m.cfrCode}`)
            .join(', ')}). The return was NOT produced — please report this.`,
        });
      }
      const verification = {
        accountsIncluded: fill.applied.size,
        codeRowsWritten: allCells.length,
        staleValuesCleared: staleRows.length,
        allWritesVerified: true,
      };

      // Tie sums use the CLOSED cells (FS equity includes the year's result);
      // Income memo rows (7501/7600) sit outside every tie range used below.
      const sumCells = (sheet: string, lo: number, hi: number) =>
        closedCells.filter((c) => c.sheet === sheet && c.cfrCode >= lo && c.cfrCode <= hi).reduce((a, c) => a + c.amount, 0);
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
      // The G99 write above uses the app's own adjustedProfit, which nets off
      // dividendsExemptPE — but that exemption is only anchored into the CfR
      // template via TRA8 (a formula-fed schedule this app does not populate),
      // so the template's own field 36a (E95) will disagree with G99 until TRA8
      // is completed manually. Flag it — this is the one case where the row-99
      // fix can't fully close the loop by itself.
      const peDividendWarning =
        (answers?.['dividendsExemptPE'] ?? 0) !== 0
          ? [
              `Participation-exemption dividends confirmed (€${Math.abs(answers!['dividendsExemptPE']).toFixed(2)}) — ` +
                `complete TRA8 with the matching exempt amount so the template's own field 36a agrees with the tax-account ` +
                `allocation on p3 row 99, then verify the "Sum of fields 37a to 37c" cross-check on p3.`,
            ]
          : [];

      // Shareholder refund working (ITMA Cap. 372 Art. 48(4)/(4A)) — always
      // computed as a preparer reference, NEVER anchored to the return.
      // Priority mirrors ITMA's own precedence: DTR claimed on FIA profits
      // overrides the passive-interest/royalties rate, which overrides a
      // participating-holding taxed election, which falls back to standard.
      const refundCategory: RefundCategory =
        (answers?.['refundDtrClaimed'] ?? 0) === 1
          ? 'dtrClaimed'
          : (answers?.['refundPassiveIncome'] ?? 0) === 1
            ? 'passiveInterestRoyalties'
            : (answers?.['refundParticipatingHolding100'] ?? 0) === 1
              ? 'participatingHolding100'
              : 'standard';
      const refund = computeRefund(comp.taxCharge, refundCategory);

      // NID working (S.L. 123.176) — computed only when claimed; never
      // anchored to TRA100 (see nid-computation.ts docstring).
      const nid =
        (answers?.['nidClaimed'] ?? 0) === 1
          ? computeNid(answers?.['nidReferenceRate'] ?? 0, answers?.['nidRiskCapital'] ?? 0, comp.chargeableIncome)
          : undefined;

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
        warnings: [...session.warnings, ...priorReviewWarnings, ...peDividendWarning, ...(tie && !tie.ok ? tie.issues : [])],
        unmatchedCodes: unmatched,
        declarations: decl.notes,
        refund,
        nid,
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
            inputs: {
              rules: rules ?? [],
              answers: answers ?? {},
              excluded: excluded ?? [],
              clientName: clientName || '',
              companyTin: companyTin || session.priorIdentity?.tin || '',
              yearOfAssessment: yearOfAssessment || '',
            },
          },
          buffer,
          summary
        );
        // Snapshot the source session so the return stays reopenable after
        // the 48h session sweep.
        try {
          fs.cpSync(path.join(SESS_DIR, req.params.id), returnSessionDir(returnId), { recursive: true });
        } catch (e) {
          console.warn('[returns] session snapshot failed:', (e as Error).message);
        }
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
      res.json({
        downloadReady: true,
        unmatched,
        tie: tie ?? null,
        returnId,
        credits: creditsLeft,
        verification,
        declarations: decl.notes,
      });
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
