# Malta Tax Return Generator — Continuation / Handoff Sheet

Last updated: 2026-07-03. Purpose: let a new chat (or a new engineer) resume this project with zero prior context.

---

## 1. What this is, in one paragraph

A standalone tool for Malta accounting/audit firms. A preparer uploads an **ETB** (extended trial balance, raw Excel), **Financial Statements**, a **blank official CfR corporate-tax e-filing Excel template**, and optionally the **client's prior-year filed return**. The tool proposes an account→CfR-code mapping (AI-proposed, human-confirmed), runs an Income-Tax-Act-grounded tax interview, writes the figures into the official CfR template, and lets **that template's own formulas compute the tax**. Output: a filled CfR return + a printable computation summary. **Non-negotiable rule: no figure on the return is ever produced by an AI model** — figures come from the ETB and human-confirmed answers; the CfR template computes the tax.

## 2. Where it lives / current status

- Repo: `C:\Users\user\Downloads\New\tax-return-generator` (standalone git repo, **not pushed to any remote**).
- Branch: `main` (v1 already merged here; the `feat/taxgen-v1` feature branch was merged and deleted).
- Stack: Node + TypeScript + Express, JSZip (OOXML), SheetJS `xlsx` (parsing), Vitest, tsx.
- Status: **v1 complete. 75 tests green, `tsc --noEmit` clean, live end-to-end smoke test green.**
- Built via brainstorm → spec → plan → subagent-driven execution, each of 8 task-groups passing spec-compliance + adversarial code-quality review. Final whole-branch review: READY TO MERGE, golden rule verified intact across module boundaries.

## 3. Run / test / verify commands

```bash
cd "C:\Users\user\Downloads\New\tax-return-generator"
npm install
npm start                 # → http://localhost:4380  (3-step web UI)
npx vitest run            # 75 tests
npx tsc --noEmit          # clean, exit 0

# Live end-to-end HTTP smoke test (start server first on the same port):
PORT=4381 npx tsx src/server.ts &   # then:
PORT=4381 npx tsx scripts/verify-http.ts

# Once you have a REAL blank CfR template (see gaps below):
npm run survey -- "path/to/blank-CfR-template.xlsx"        # dump sheet names + code/value rows
npm run replay -- --etb <etb.xlsx> --filed <filed-return.xlsx> [--prior <prior.xlsx>]  # accuracy score
```

## 4. Data flow (end to end)

1. Upload ETB + FS + blank CfR template (+ optional prior return) → `POST /api/session`.
2. `parseEtb` normalizes the raw ETB to `{accountCode, accountName, cyBalance, pyBalance}` (Dr +, Cr −). Hardened against sign/format misparses.
3. If a prior return is uploaded: **review-first gate** runs `reviewPriorReturn` (see §6) BEFORE it's used for anything.
4. `proposeMappingAI` proposes CoA→CfR-code rules (**proposal only**; heuristic fallback; default model `claude-fable-5`). Grounded by the prior return's codes when present.
5. `buildInterview` builds the Act-grounded tax questionnaire with deterministic pre-answers from the ETB.
6. Preparer reviews/edits mapping + answers in the UI (Step 2). Nothing auto-accepted.
7. `POST /generate`: `applyMapping` aggregates ETB figures by confirmed CfR code → `fillCfrReturn` writes each into column E of the matching code row (never touches formulas) + net profit into p3!E6 → sets `fullCalcOnLoad` so Excel/LibreOffice recomputes tax on open.
8. Downloads: filled `return.xlsx` + `summary.html` (workings + provenance + any manual-entry items + warnings).

## 5. What it DOES vs DOESN'T fill (read this — it's the key nuance)

- **DOES auto-write:** every mapped ETB line — all balance-sheet accounts and all P&L accounts land on their CfR-code rows — plus net profit. The template's formulas then compute all totals, the 35% charge, refunds, and tax-account allocations from those inputs. The financial-statements data-entry surface is filled in full.
- **DOESN'T auto-write yet:** the tax-computation *adjustment* lines (depreciation add-back, losses brought forward, capital allowances, other interview items). These are computed and listed on the computation summary as "enter on the return" reminders. Reason: the tool locates account lines by CfR code, but doesn't yet know which specific cell holds "losses brought forward" etc. — that's what surveying a real template fixes (see §7).

## 6. Prior-return review-first gate (user requirement)

Uploaded prior return is reviewed for errors **before** it's relied on: `reviewPriorReturn` detects the return's sign **convention** ('signed' Dr+/Cr− vs 'positive' all-values-positive, since real filed CfR returns are usually all-positive), checks the balance sheet balances under that convention, flags unreadable/empty templates, and lists the top residual codes when it doesn't balance. Error-severity findings are surfaced in the UI (red) and the preparer **must tick an acknowledgment checkbox** before `POST /generate` will proceed (server returns 400 mentioning "prior-year return review" otherwise). `impliedNetProfit` is null for non-signed conventions (never a guessed figure). The prior-year cross-check re-maps the ETB's PY balances and compares to the filed values to catch mapping errors.

## 7. KNOWN GAPS / NEXT STEPS (prioritized)

All of the "professional-grade full fill" gaps trace to one dependency: **we need a real blank current-year CfR e-filing template** (or a filed return to read structure from). Fixtures are gitignored/absent; see `scripts/fetch-fixtures.md`.

1. **Populate `src/template-map.ts` ANCHORS.** 8 of 9 anchors are `null` (only `netProfitPerAccounts`→p3!E6 is wired). Run `npm run survey` against a real template, read the sheet/row dump, and record the cell refs for `lossesBroughtForward`, `capitalAllowancesTotal`, `depreciationAddBack`, `finesPenaltiesAddBack`, `donationsAddBack`, `entertainmentAddBack`, `unrealizedFxAddBack`, `dividendsExemptPE`. Once set, those interview answers auto-write into the template instead of being manual-entry reminders. **This is the single highest-value next step for "fills the full sheet".**
2. **Wire prior-year continuity lifting.** Spec calls for deterministically lifting losses b/f, capital-allowance TWDVs (TRA5 roll-forward), and FTA/MTA/IPA/FIA/UA tax-account balances from the prior return. Currently `prior-return.ts` only extracts code/value pairs + convention. `interview.ts` has a `priorLossesBroughtForward` context field that `server.ts` never populates — wire it from the prior return (needs the anchor rows from step 1 to know where these sit).
3. **Corpus replay accuracy pass.** Once ANCHORS + a real template exist, run `npm run replay` over consecutive-year pairs from the 347 filed returns (Dropbox `/Tax Returns Consolidated`, 66 clients — e.g. MGW Investments YA2021–2026, Gatt & elmer YA2017–2023) to get a measurable accuracy score and the marketing claim "validated against hundreds of real filed Malta returns."
4. **Model refinement (user's stated plan).** User will refine the mapping/proposal step with **Claude Fable 5**. Default model id is already `claude-fable-5` in `src/ai-mapper.ts` (env-overridable via `ANTHROPIC_MODEL`). Ask the user what "refine" means (accuracy tuning on the mapping? few-shot grounding with corpus examples? something else) before building.
5. **Later:** portal integration (core modules `template-writer`/`template-reader`/`mapping`/`interview`/`prior-return` are deliberately dependency-free — no express/multer imports — for reuse inside the VACEI/A4 audit portal, which reads ETB from `EngagementEtb`); multi-tenant product layer (workspaces, sign-off trail); non-trading entity profiles (IP/royalty, funds, NGOs, property); multiple template vintages; COR correction-form workflow.

## 8. What was reused vs built

- **Reused** from branch `feat/malta-cit-tax-return` in `C:\Users\user\Downloads\vacei-stack\_reint_be` (~70% done, reportedly merged to that portal's main): the OOXML `template-writer` (writes ETB figures into CfR-code rows, never touches formulas → template computes the tax) and the `mapping` PROPOSALS heuristic table. **No hand-coded tax engine** — the official workbook is the engine.
- **Built new:** raw ETB parser, FS tie-check, prior-return intake + review gate + cross-check, template-reader, Act-grounded interview, computation summary, AI mapper (env-gated), 3-step web UI, corpus-replay harness.
- **Upstream bug flagged:** the same `setCell` `$`-replacement-pattern corruption bug (silently mangles rows containing `$`-style absolute formula refs) exists in the `_reint_be` writer. A background task chip was spawned to fix it there (fixed here in the standalone). If resuming, confirm whether that upstream fix landed.

## 9. File map (src/)

- `domain.ts` — shared types (EtbAccount, MappingRule/Profile, InterviewFill, CfrSheet).
- `template-writer.ts` — OOXML/JSZip writer (locate row by CfR code, write col E, `fullCalcOnLoad`). PORTED.
- `template-reader.ts` — read (sheet, code, value) triples; used by prior-return + replay.
- `etb-parser.ts` — raw ETB Excel → normalized accounts; hardened number/column handling.
- `fs-tie-check.ts` — extract net profit + total assets from FS; tie vs mapped ETB with explicit not-compared states.
- `mapping.ts` — applyMapping (ETB figures by confirmed code), netProfitFromMapping, proposeMapping heuristics (PROPOSALS table, verbatim from upstream).
- `ai-mapper.ts` — env-gated Claude mapping proposal; strict validation; heuristic fallback; prompt sanitization. PROPOSAL ONLY.
- `prior-return.ts` — readPriorReturn, reviewPriorReturn (convention-aware error review), priorYearCrossCheck.
- `template-map.ts` — ANCHORS (mostly null — see gap #1).
- `interview.ts` — Act-grounded conditional questions, sign-disciplined deterministic pre-answers, fillsFromAnswers.
- `computation-summary.ts` — printable HTML workings with provenance + manual-entry flags.
- `server.ts` — Express app, in-memory sessions, the 4 endpoints, prior-review gate, multer error→JSON.
- `public/index.html` — 3-step UI (upload → confirm mapping+interview → download), prior-review panel + acknowledgment gate.
- `scripts/` — `survey-template.ts` (discover anchors), `replay.ts` (accuracy), `verify-http.ts` (live smoke), `fetch-fixtures.md`.

## 10. References

- Design spec: `docs/superpowers/specs/2026-07-02-tax-return-generator-design.md`
- Implementation plan (note: some plan code blocks are stale vs shipped code, expected drift): `docs/superpowers/plans/2026-07-02-tax-return-generator-v1.md`
- README: `README.md`
- Income Tax Act (Cap. 123) reference PDF the user supplied is an extract only (arrangement + Part I); the full Act + subsidiary rules (capital-allowance/wear-and-tear rates) should be sourced from legislation.mt when deepening the interview rule tables.
- Auto-memory note: `tax-return-generator-build` (in the user's Claude memory index).

## 11. Suggested opening move for the new chat

> "Resume the Malta tax return generator at C:\Users\user\Downloads\New\tax-return-generator (see docs/CONTINUATION.md). I have a real blank CfR template here: <path>. Run `npm run survey` on it, populate the ANCHORS in src/template-map.ts so the tax-adjustment lines (losses b/f, capital allowances, add-backs) auto-write, wire prior-year continuity lifting, then replay against a filed return to check accuracy."
