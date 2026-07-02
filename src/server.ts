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
import { readPriorReturn, priorYearCrossCheck, reviewPriorReturn, type PriorReturnReview } from './prior-return';
import { proposeMappingAI } from './ai-mapper';
import { applyMapping, netProfitFromMapping } from './mapping';
import { buildInterview, fillsFromAnswers } from './interview';
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
        const interview = buildInterview(parsed.accounts, { hasPriorReturn: !!priorCodes });

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
          directCells.push({ sheet: a.sheet, ref: a.ref, value: f.amount });
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

  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4380);
  createApp().listen(port, () => console.log(`Tax Return Generator on http://localhost:${port}`));
}
