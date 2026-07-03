# Malta Tax Return Generator

A standalone web tool for preparing a Maltese corporate income tax return (CfR
form). A preparer uploads a raw Extended Trial Balance (ETB), the financial
statements, and a blank CfR corporate tax template (plus, optionally, the
prior-year filed return), confirms an account mapping and a short tax
interview, and downloads a professionally filled-in CfR return plus a
computation summary showing the workings.

## Golden rule

**No figure on the return is ever produced by an AI model.** Every amount
comes from the ETB (as parsed) or from an interview answer the preparer has
explicitly confirmed. Tax itself is computed by the official CfR workbook's
own formulas — this tool only writes input values into the template and sets
it to recalculate on open (`fullCalcOnLoad`). AI, when configured, is used for
exactly two things, both advisory and both figure-free: (1) *proposing* which
ledger account maps to which CfR code — a suggestion the preparer reviews and
confirms line by line; and (2) a *reasonableness review* of the draft
computation that raises prose review points (e.g. "depreciation charged but
not added back") for a human to judge — it never writes or proposes a number,
and never blocks generation. Absent an API key, mapping falls back to a
deterministic heuristic table and the review reports "unavailable" — no loss
of the core workflow.

## Configuration

The tool runs with **no configuration**. To enable the AI mapping proposal and
reasonableness review, copy `.env.example` to `.env` (gitignored) and set
`ANTHROPIC_API_KEY` (the account needs a positive credit balance). `npm start`
and `npm run dev` load `.env` automatically if present. Never paste a key onto
a command line or into any committed file.

## Quickstart

```bash
npm install
npm start
```

Then open http://localhost:4380 and work through the three steps:

1. **Upload** — the ETB (Excel, required), the financial statements (Excel,
   optional — enables the FS tie-check), the blank CfR return template
   (required), and, optionally, the prior-year filed return.
2. **Confirm mapping & tax interview** — review the proposed ledger→CfR-code
   mapping (AI-proposed or heuristic, each row shows a confidence badge and
   is fully editable; unmapped accounts are highlighted and must be mapped
   or explicitly excluded before you can proceed), then answer the
   Act-grounded tax interview questions (add-backs, losses brought forward,
   capital allowances, etc. — pre-filled from the ETB where a deterministic
   figure exists, always editable).
3. **Download** — the filled tax return (`.xlsx`, recalculates in
   Excel/LibreOffice on open) and the computation summary (an HTML workings
   document showing profit per accounts, every adjustment, full mapping
   provenance, and any warnings).

## Prior-year return: reviewed before use

If a prior-year filed return is uploaded, it is never taken at face value.
The tool runs a deterministic review (`reviewPriorReturn`) before using it
for anything — checking that its balance sheet codes net to zero, that its
own implied net profit is internally consistent, and flagging any code rows
with no value. If that review turns up an **error**-severity finding, Step 2
opens with a highlighted review panel and generation is blocked until the
preparer explicitly ticks "I have reviewed these prior-year findings and
choose to proceed" (the UI then sends `priorReviewAcknowledged: true` with
the generate request; the API returns 400 otherwise). Warning-severity
findings and the acknowledged errors both carry through to the computation
summary so there is a permanent record of what was flagged and accepted.
Beyond the review gate, the prior return also feeds a **prior-year
cross-check**: the ETB's prior-year balances are mapped with the same
profile and compared against what the prior return actually reported,
surfacing per-code mismatches that usually indicate a mapping error (or an
error in the prior return itself).

## Fixture policy

Real client files (ETBs, filed returns, blank templates) are sensitive and
are **never committed** — `fixtures/` is gitignored. See
[`scripts/fetch-fixtures.md`](scripts/fetch-fixtures.md) for how to pull a
corpus sample (via the firm's Dropbox) and the directory layout the survey
and replay tooling expect. Every parser and writer has synthetic-data tests
that always run in CI/locally; anything that needs the real corpus is
written with `describe.skipIf(...)` so the suite stays green without
fixtures and lights up automatically once they're present.

## Survey and replay tooling

- **`npm run survey -- <workbook.xlsx> [SheetName ...]`** — diagnostic tool
  for a real CfR template: lists every sheet name and dumps
  `(row, CfR code, value)` triples for the sheets that look relevant
  (`B_Sheet`, `Income`, `TRA*`, `p*`). Use its output to populate the
  `ANCHORS` map in `src/template-map.ts` (losses brought forward, capital
  allowances totals, etc.) as more of the real template gets surveyed.

- **`npm run replay -- --etb <etb.xlsx> --filed <filed-return.xlsx> [--prior <prior.xlsx>]`**
  — corpus replay harness. It parses a real ETB, proposes a mapping
  (heuristic, optionally biased by a prior return's code set), and scores
  what share of an *actually-filed* return's code values the mapped ETB
  reproduces within €1 — no blank template required. Prints a per-code miss
  list for anything that doesn't reproduce. `tests/corpus.replay.test.ts`
  exercises the same `replayAccuracy` function against a synthetic fixture
  (always runs) and, when `fixtures/etb/<Client>/` and
  `fixtures/returns/<Client>/` are both populated, also replays each real
  client pair automatically (skipped otherwise).

- **`PORT=4381 npx tsx scripts/verify-http.ts`** — a live HTTP smoke check
  against a *running* server (start one first, e.g. `PORT=4381 npm start`
  in another terminal). It drives the full session lifecycle over real HTTP:
  upload, the prior-review block/acknowledge gate, generation, and both
  download endpoints — useful as a fast end-to-end sanity check beyond the
  unit/integration test suite.

## v1 limits

- Wired for the **current CfR return template only** (anchors beyond the
  B_Sheet/Income code rows — losses b/f, capital allowances, TRA totals —
  start unpopulated in `src/template-map.ts` and grow via `npm run survey`
  against real templates as they're examined).
- Aimed at **standard trading companies**; non-trading entity profiles and
  multiple template vintages are out of scope for v1 (see the plan's
  post-v1 backlog).
- Sessions are **in-memory and single-workstation** — there is no
  persistence, multi-user access, or hosted deployment in v1.

## Reuse in the portal

The core modules — `src/template-writer.ts`, `src/template-reader.ts`,
`src/mapping.ts`, `src/interview.ts`, and `src/prior-return.ts` — are
dependency-free (no Express, no Prisma, no engagement/session types) so they
can be lifted directly into the full VACEI portal for a future
portal-integrated tax-return feature without modification.

## Development

```bash
npm test         # vitest run — synthetic suite always green, real-corpus tests skip without fixtures
npm run typecheck # tsc --noEmit
npm run dev       # tsx watch src/server.ts
```
