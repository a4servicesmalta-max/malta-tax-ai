# Malta Tax Return Generator — Design (v1)

Date: 2026-07-02 (revised same day after product review)

## Goal

A market-grade product for Malta accounting and audit firms: the preparer uploads an ETB, Financial Statements, a blank official CfR (Commissioner for Revenue) corporate income tax e-filing Excel template, and optionally the client's prior-year return, then answers a structured tax interview. The tool fills the template professionally — as if a tax professional completed it — without any figure on the return ever being produced by an AI guess.

## Scope of v1

- **Delivery surface:** standalone tool first (not portal-integrated yet).
- **Entity profile:** standard Malta trading company only. IP/royalty holding companies, funds, NGOs/foundations, and property companies are later extensions.
- **Tax mechanics:** full corporate mechanics (chargeable income, 35% tax, refund system, participation exemption, NID, FIA/MTA/FTA/IPA/UA tax accounts) — achieved by writing figures into the *official CfR template*, not by reimplementing the Income Tax Act as a separate calculator (see Prior Art below).
- **Input format:** raw ETB and FS Excel/Word files as auditors currently save them — not a normalized export. The tool owns its own parsing/normalization.
- **Prior-year return (optional input):** the client's filed prior-year CfR return, same template family. When provided, the tool deterministically lifts continuity balances (losses carried forward, capital-allowance TWDVs from the TRA5 roll-forward, FTA/MTA/IPA/FIA/UA tax-account balances) and uses the client's own prior mapping as the strongest mapping precedent. When absent, the interview asks for these balances instead.
- **Prior-return review gate (user requirement, 2026-07-02):** before ANY working is based on the prior-year return, the tool reviews it for errors and surfaces findings to the preparer. Deterministic checks: balance-sheet code sums balance (assets vs equity+liabilities), income-code sum reconciles to the return's net-profit figure, ETB prior-year comparatives reproduce the filed values (the cross-check), and continuity figures are plausible (e.g. no positive "loss" balances). Findings are shown prominently in the UI; the preparer must explicitly acknowledge them (or drop the prior return as a basis) before generation proceeds. Errors never silently propagate into the new return.
- **Template version:** current CfR e-filing template only. Older vintages (YA2006–YA2024) are not a support target; they're used only where they still match the current format, for validation.
- **Output:** an actual filled copy of the uploaded CfR template, with `fullCalcOnLoad` set so the template's own formulas compute tax when the auditor opens it in Excel/LibreOffice.

## Prior Art — Reused, Not Rebuilt

A prior effort already exists: branch `feat/malta-cit-tax-return` in `C:\Users\user\Downloads\vacei-stack\_reint_be` (reportedly merged to main 2026-07-02), ~70–75% complete. It is portal-integrated (reads ETB from the `EngagementEtb` Prisma table) but its core logic is DB-agnostic and reusable:

- `maltaCit.mapping.ts` — AI-proposed chart-of-accounts → CfR-code mapping, human-confirmable.
- `maltaCit.template-writer.ts` — OOXML/JSZip writer that locates each CfR-code row in the template by its code (column C) and writes the signed amount into column E, never touching formulas. This is the key architectural insight: the CfR template's own formulas already compute the 35% rate, refund system (6/7, 5/7, 2/3), FTA/IPA/MTA/FIA allocation, and capital allowances (via its TRA5 sheet) — so none of that needs to be hand-coded.
- Golden rule already enforced in that code: "No figure on the return is ever produced by an AI model." Figures = ETB `final_balance` (deterministic). Tax = template formulas (authoritative). AI's only role is proposing the mapping and election answers, both human-confirmed.

This design **reuses** `mapping.ts` and `template-writer.ts` (ported/adapted to not require Prisma) rather than rebuilding tax logic from scratch.

## New Components (v1)

1. **Raw ETB parser** — normalizes real client ETB spreadsheets (varying formats, as seen across the firm's Dropbox client folders) into `{account code, account name, CY balance, PY balance}`.
2. **Raw FS parser** (Excel/Word) — used to sanity-check that ETB figures tie to the signed FS. Not a second source of tax figures.
3. **Tax-data interview** (supersedes the narrower "elections workflow") — a structured, conditional questionnaire covering the full tax computation, not just elections: losses brought forward, capital allowances (prior-year TRA5 roll-forward confirmation or FA-register figures), dividend/interest/investment income sources, related-party items, and non-deductible classifications the AI flags from account names (fines, entertainment portions, formation expenses, unrealized differences, depreciation add-back). AI pre-answers where the uploaded documents support it; the preparer confirms every answer. Each question is grounded in the specific Income Tax Act article (deduction rules Arts 14–26, exemptions Arts 12–13) so answers are defensible. Same human-in-the-loop pattern as mapping. Built once here, reusable later by the portal branch.
4. **Prior-year return parser** — reads the client's filed prior-year CfR workbook (same template family) to extract continuity balances and the prior mapping. Deterministic extraction, no AI.
5. **3-step web UI:**
   - Upload ETB + FS + blank current-year CfR template (+ optional prior-year return)
   - Review/edit AI-proposed account mapping and complete the tax-data interview
   - Download the filled CfR template + computation summary
6. **Computation summary output** — a printable workings document alongside the filled template: accounting profit → add-backs → capital allowances → chargeable income → tax → tax-account allocation, with each adjustment traced to its interview answer or mapping. This is what makes the output read as professionally prepared and gives reviewers the workings, not just the form.
7. **Mapping-quality grounding from the 347 historical returns** — the AI mapping proposal is grounded with examples drawn from the real historical returns already consolidated from Dropbox (`/Tax Returns Consolidated`, 347 files across 66 clients). This is the corpus's actual role: improving mapping accuracy, not encoding tax law. Precedence order: client's own prior-year return mapping first, then firm-wide corpus examples.
8. **Act-derived rule tables** — deterministic reference tables built from the full Income Tax Act (Cap. 123) and its subsidiary legislation (capital allowance / wear-and-tear rates, deduction rules): add-back triggers, allowance categories and rates, exemption flags. The attached 14-page PDF is only an extract (arrangement + Part I); the full Act and the relevant subsidiary rules must be sourced (legislation.mt) during implementation. These tables drive interview questions and validation checks — they are lookup data, not a computation engine (the CfR template remains the computation authority).

## Data Flow

1. Preparer uploads ETB (raw Excel) + FS (raw Excel/Word) + blank current-year CfR template, and optionally the prior-year filed return.
2. ETB parser normalizes to account-level CY/PY balances. Prior-year parser (if provided) extracts continuity balances and prior mapping.
3. Reconciliation check: do ETB balances tie to the FS? If not, warn before proceeding.
4. AI proposes chart-of-accounts → CfR-code mapping — client's prior-year mapping first, then corpus examples as grounding.
5. Tax-data interview: AI pre-answers what the documents support (flagged add-backs, allowance roll-forward, income classification); preparer confirms or edits every answer. Nothing is silently accepted.
6. Template-writer locates each CfR-code row in the uploaded blank template and writes the confirmed signed amount into column E, leaving all formulas untouched. Interview-driven figures (add-backs, allowances, losses, tax-account splits) land on their respective schedule rows the same way.
7. Output: filled CfR Excel (`fullCalcOnLoad` set so Excel/LibreOffice recomputes on open) + printable computation summary tracing every adjustment to its source.

## Tech Stack & Location

New standalone app at `Downloads/New/tax-return-generator` — Node + TypeScript + Express, matching the existing `auditpilot` / `thcp-autopilot` pattern (own `.tools` node runtime, local web UI).

## Validation Strategy — Corpus Replay

The corpus replay harness is the product's proof. For clients with consecutive-year returns in the corpus: feed the YA N-1 filed return plus the year-N ETB (located in the same Dropbox client folder's audit file), generate the year-N return, and diff against the actually-filed year-N return. This yields a measurable accuracy score per return and per field category (mapping, add-backs, allowances, continuity), and ultimately the product claim: validated against hundreds of real filed Malta returns.

v1 starts with a handful of representative clients (building the full 66-client harness is a follow-on), but the harness is designed from day one to scale to the whole corpus.

## Error Handling

- Any account the mapper isn't confident about is flagged "needs mapping," never defaulted or guessed.
- If the uploaded blank template doesn't match the expected current-year layout, the tool rejects it with a clear "unsupported template version" error rather than mis-locating rows.
- If ETB CY/PY balances don't reconcile to the FS, the tool warns rather than proceeding silently.

## Testing

- Unit tests for the ETB parser against real sample ETB files pulled from the Dropbox client folders.
- Unit tests for the template-writer against a blank current CfR template — confirms correct row-location and that formulas are never touched.
- One or two end-to-end integration tests using real historical client cases with a known filed outcome.

## Explicitly Out of Scope for v1

- Portal integration (reusing the same core modules is a deliberate design choice to make this easy later, but wiring into the portal itself is a follow-on project).
- Non-trading-company entity profiles (IP/royalty holding, funds, NGOs, property companies).
- Multiple CfR template vintages / version detection.
- Server-side recalculation/verification of the computed tax (relies on Excel/LibreOffice's own formula engine on open).
- Multi-tenant firm features: per-return workspaces, user accounts, review/sign-off audit trail, hosted SaaS deployment. v1 is a single-workstation tool; the firm-product layer is the follow-on once the engine is proven. (The computation summary IS in v1 because it's what makes output read as professionally prepared.)
- COR (correction/adjustment form) workflows — filing corrections to prior returns is real-world practice visible in the corpus, but a later extension.

## Planned Follow-On (per user, noted for context)

User intends to use Claude Fable 5 to refine the model (likely the mapping-proposal step) after this initial build — no further detail yet on what "refine" means; revisit when relevant.
