# Malta Tax Return Generator v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone web tool where a preparer uploads a raw ETB + FS + blank CfR corporate tax template (+ optional prior-year return), completes a confirmed mapping and tax interview, and downloads a professionally filled CfR return plus a computation summary — with no figure ever produced by AI.

**Architecture:** Port the proven `maltaCit` core (OOXML template-writer, mapping layer) from `C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\` into a dependency-free standalone app. Add new raw-file parsers (ETB, FS, prior return), a conditional tax-data interview, a computation summary, an Express + static-HTML 3-step UI, and a corpus-replay harness. The official CfR workbook remains the tax computation engine — we only write input values and set `fullCalcOnLoad`.

**Tech Stack:** Node 20+, TypeScript (strict), Express 4, multer (uploads), JSZip (OOXML writing/reading), SheetJS `xlsx` (raw ETB/FS parsing), Vitest + supertest (tests), tsx (dev runner). Optional `@anthropic-ai/sdk` for AI mapping proposal (env-gated, heuristic fallback).

**Repo:** `C:\Users\user\Downloads\New\tax-return-generator` (git initialized, spec committed at `docs/superpowers/specs/2026-07-02-tax-return-generator-design.md`).

**Source to port (read these before Tasks 3–5):**
- `C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\maltaCit.template-writer.ts` (199 lines — port near-verbatim)
- `C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\maltaCit.mapping.ts` (178 lines — port with adaptations described in Task 5)
- `C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\maltaCit.domain.ts` (types reference)

**Golden rule (inherited, non-negotiable):** No figure on the return is ever produced by an AI model. Figures come from the ETB and confirmed interview answers; tax is computed by the CfR template's own formulas; AI only proposes mappings/answers that a human confirms.

**Fixture policy:** Real client files live in `fixtures/` which is **gitignored** (sensitive data). Every parser/writer has synthetic-data tests that always run; real-corpus tests use `describe.skipIf` so the suite is green without fixtures.

## File Structure

```
tax-return-generator/
├── package.json / tsconfig.json / vitest.config.ts / .gitignore
├── src/
│   ├── domain.ts               # standalone types (EtbAccount, CfrFillCell, session shapes)
│   ├── template-writer.ts      # PORTED: OOXML writer (locate row by CfR code, write col E)
│   ├── template-reader.ts      # NEW: read (sheet, code, value) triples from a filled return
│   ├── etb-parser.ts           # NEW: raw ETB Excel -> EtbAccount[]
│   ├── fs-tie-check.ts         # NEW: reconcile ETB totals vs FS figures
│   ├── prior-return.ts         # NEW: prior-year return -> code set + values + cross-check
│   ├── mapping.ts              # PORTED+ADAPTED: heuristics, applyMapping, prior-year bias
│   ├── ai-mapper.ts            # NEW: env-gated Claude mapping proposal, heuristic fallback
│   ├── interview.ts            # NEW: Act-grounded conditional question catalog + engine
│   ├── computation-summary.ts  # NEW: HTML workings document
│   └── server.ts               # Express app + in-memory sessions + endpoints
├── public/
│   └── index.html              # 3-step UI (single file, vanilla JS)
├── scripts/
│   ├── fetch-fixtures.md       # how to pull corpus samples via Dropbox (manual/MCP step)
│   ├── survey-template.ts      # dump sheet names + code/value rows from a CfR workbook
│   └── replay.ts               # corpus replay CLI: prior + ETB vs actually-filed return
├── src/template-map.ts         # anchors discovered by survey (starts minimal, grows)
└── tests/
    ├── helpers/synthetic.ts    # build tiny xlsx + tiny CfR-like OOXML zips in-memory
    ├── template-writer.test.ts
    ├── template-reader.test.ts
    ├── etb-parser.test.ts
    ├── fs-tie-check.test.ts
    ├── prior-return.test.ts
    ├── mapping.test.ts
    ├── interview.test.ts
    ├── computation-summary.test.ts
    ├── server.test.ts
    └── corpus.replay.test.ts   # skipIf(no fixtures)
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "tax-return-generator",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "survey": "tsx scripts/survey-template.ts",
    "replay": "tsx scripts/replay.ts"
  },
  "dependencies": {
    "express": "^4.19.2",
    "jszip": "^3.10.1",
    "multer": "^1.4.5-lts.1",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/multer": "^1.4.11",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 },
});
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
dist/
fixtures/
*.log
.env
```

- [ ] **Step 5: Install and verify**

Run: `cd "C:\Users\user\Downloads\New\tax-return-generator" && npm install && npx tsc --noEmit`
Expected: install succeeds; tsc exits 0 (no source files yet is fine).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore package-lock.json
git commit -m "chore: scaffold standalone tax return generator"
```

---

### Task 2: Fixture acquisition doc + synthetic test helpers

Real client corpus files cannot be committed. Document how to fetch them; build synthetic helpers all tests can rely on.

**Files:**
- Create: `scripts/fetch-fixtures.md`, `tests/helpers/synthetic.ts`, `fixtures/.keep` (empty, forces dir; note `.keep` itself IS committed via `!` rule — skip, just mkdir at runtime)

- [ ] **Step 1: Write `scripts/fetch-fixtures.md`**

```markdown
# Fetching real corpus fixtures (sensitive — never commit)

Fixtures live in `fixtures/` (gitignored). Source: Dropbox `/Tax Returns Consolidated`
(347 filed returns, 66 clients) and `/Clients/Current clients/<name>` audit files (ETBs).

Recommended sets:
- **Replay pairs (consecutive years):** MGW Investments Limited (TR 997823415 YA2021–YA2026),
  Gatt & elmer (TR 997761312 YA2017–YA2023).
- **Current template structure:** New Way Trading Ltd `TR 971913522 YA2025 (1).xlsx`.
- **ETBs:** search the same client folder's audit-year subfolders for `ETB*.xlsx` / `*trial balance*`.

How to fetch (Dropbox MCP cannot write binaries locally — use temporary links):
1. In a Claude session with the Dropbox connector: call `download_link` for each file id/path.
2. `curl -L -o "fixtures/<name>.xlsx" "<temporary link>"` (links are single-use, expire fast).

Layout expected by tests/replay:
fixtures/
  returns/<Client>/<original filename>.xlsx
  etb/<Client>/<year>.xlsx
  blank-template.xlsx        # current-year blank CfR template (from cfr.gov.mt or firm copy)
```

- [ ] **Step 2: Write `tests/helpers/synthetic.ts`** — builds (a) a minimal CfR-like OOXML workbook via JSZip with `B_Sheet`/`Income`/`p3` sheets whose column C holds CfR codes, and (b) raw ETB xlsx buffers via SheetJS.

```ts
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WB = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="B_Sheet" sheetId="1" r:id="rId1"/>
<sheet name="Income" sheetId="2" r:id="rId2"/>
<sheet name="p3" sheetId="3" r:id="rId3"/>
</sheets>
</workbook>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
</Relationships>`;

/** Sheet with rows: col C = CfR code, col E = existing value (0), col D untouched formula cell. */
function sheetXml(rows: Array<{ row: number; code: number; value?: number }>): string {
  const body = rows
    .map(
      (r) =>
        `<row r="${r.row}"><c r="C${r.row}"><v>${r.code}</v></c>` +
        `<c r="D${r.row}"><f>SUM(E${r.row})</f><v>0</v></c>` +
        (r.value !== undefined ? `<c r="E${r.row}"><v>${r.value}</v></c>` : '') +
        `</row>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export interface SyntheticRow {
  row: number;
  code: number;
  value?: number;
}

/** Build a minimal CfR-like workbook. p3 gets a bare E6 row for the net-profit direct write. */
export async function syntheticCfrWorkbook(opts: {
  bSheet: SyntheticRow[];
  income: SyntheticRow[];
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('xl/workbook.xml', WB);
  zip.file('xl/_rels/workbook.xml.rels', WB_RELS);
  zip.file('xl/worksheets/sheet1.xml', sheetXml(opts.bSheet));
  zip.file('xl/worksheets/sheet2.xml', sheetXml(opts.income));
  zip.file(
    'xl/worksheets/sheet3.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="6"><c r="E6"><v>0</v></c></row></sheetData></worksheet>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Build a raw ETB xlsx buffer from row arrays (first array = header row). */
export function syntheticEtbXlsx(rows: (string | number | null)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ETB');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-fixtures.md tests/helpers/synthetic.ts
git commit -m "test: synthetic CfR/ETB fixture builders + corpus fetch doc"
```

---

### Task 3: Port the template writer

**Files:**
- Create: `src/template-writer.ts` (port of `maltaCit.template-writer.ts` — change nothing except the header comment noting provenance)
- Test: `tests/template-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { fillCfrReturn } from '../src/template-writer';
import { syntheticCfrWorkbook } from './helpers/synthetic';

describe('fillCfrReturn', () => {
  it('writes amounts into column E of the row matching each CfR code', async () => {
    const tpl = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150 },
        { row: 11, code: 3801 },
      ],
      income: [{ row: 5, code: 5000 }],
    });
    const { buffer, unmatched } = await fillCfrReturn(
      tpl,
      [
        { sheet: 'B_Sheet', cfrCode: 2150, amount: 1234.56 },
        { sheet: 'B_Sheet', cfrCode: 3801, amount: -1000 },
        { sheet: 'Income', cfrCode: 5000, amount: -50000 },
      ],
      [{ sheet: 'p3', ref: 'E6', value: 42000 }]
    );
    expect(unmatched).toEqual([]);
    const zip = await JSZip.loadAsync(buffer);
    const b = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(b).toContain('<c r="E10"><v>1234.56</v></c>');
    expect(b).toContain('<c r="E11"><v>-1000</v></c>');
    // formulas untouched
    expect(b).toContain('<f>SUM(E10)</f>');
    const p3 = await zip.file('xl/worksheets/sheet3.xml')!.async('string');
    expect(p3).toContain('<c r="E6"><v>42000</v></c>');
    // recalc-on-open set
    const wb = await zip.file('xl/workbook.xml')!.async('string');
    expect(wb).toContain('fullCalcOnLoad="1"');
  });

  it('reports unmatched codes instead of silently dropping them', async () => {
    const tpl = await syntheticCfrWorkbook({ bSheet: [{ row: 10, code: 2150 }], income: [] });
    const { unmatched } = await fillCfrReturn(tpl, [
      { sheet: 'B_Sheet', cfrCode: 9999, amount: 5 },
    ]);
    expect(unmatched).toEqual([{ sheet: 'B_Sheet', cfrCode: 9999 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/template-writer.test.ts`
Expected: FAIL — cannot resolve `../src/template-writer`.

- [ ] **Step 3: Port the implementation**

Copy `C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\maltaCit.template-writer.ts` to `src/template-writer.ts` unchanged, replacing only the first header line with:

```ts
/**
 * Server-side OOXML writer for the CfR return template.
 * Ported from vacei-stack _reint_be maltaCit.template-writer.ts (feat/malta-cit-tax-return).
 * ... (keep the rest of the original header comment)
 */
```

The module exports `CfrCodeCell`, `CfrDirectCell`, `FillResult`, `fillCfrReturn` — all used above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/template-writer.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/template-writer.ts tests/template-writer.test.ts
git commit -m "feat: port CfR OOXML template writer from malta-cit branch"
```

---

### Task 4: Template reader (values by code — powers prior-return parsing and replay diffs)

**Files:**
- Create: `src/template-reader.ts`
- Test: `tests/template-reader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readCfrValues, listSheetNames } from '../src/template-reader';
import { syntheticCfrWorkbook } from './helpers/synthetic';

describe('template-reader', () => {
  it('lists sheet names', async () => {
    const wb = await syntheticCfrWorkbook({ bSheet: [], income: [] });
    expect(await listSheetNames(wb)).toEqual(['B_Sheet', 'Income', 'p3']);
  });

  it('reads (code, value) pairs from requested sheets', async () => {
    const wb = await syntheticCfrWorkbook({
      bSheet: [
        { row: 10, code: 2150, value: 111.5 },
        { row: 11, code: 3801 }, // no E value -> null
      ],
      income: [{ row: 5, code: 5000, value: -9000 }],
    });
    const vals = await readCfrValues(wb, ['B_Sheet', 'Income']);
    expect(vals).toEqual([
      { sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: 111.5 },
      { sheet: 'B_Sheet', cfrCode: 3801, row: 11, value: null },
      { sheet: 'Income', cfrCode: 5000, row: 5, value: -9000 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/template-reader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/template-reader.ts`** (reuses the same prefix/sheet-map logic as the writer; keep the small helpers duplicated rather than exporting writer internals — they are private regex utilities, and coupling reader to writer internals would make the port drift harder later. Total ~80 lines, acceptable duplication documented in the header.)

```ts
/**
 * Reads (sheet, CfR code, value) triples from a filled CfR workbook.
 * Column C = CfR code, column E = value — same convention the writer uses.
 * Used for: recovering the code set of a prior-year return, replay diffs.
 */
import JSZip from 'jszip';

export interface CfrValue {
  sheet: string;
  cfrCode: number;
  row: number;
  value: number | null;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function detectPrefix(xml: string): string {
  const m = xml.match(/<(\w+:)?(?:workbook|worksheet|sheetData|sheets|row|c)\b/);
  return m && m[1] ? m[1] : '';
}

async function sheetPaths(zip: JSZip): Promise<Record<string, string>> {
  const wbXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const relTarget: Record<string, string> = {};
  const rp = relsXml.match(/<(\w+:)?Relationship\b/)?.[1] ?? '';
  for (const m of relsXml.matchAll(new RegExp(`<${rp}Relationship\\b[^>]*>`, 'g'))) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTarget[id] = target;
  }
  const p = detectPrefix(wbXml);
  const out: Record<string, string> = {};
  for (const m of wbXml.matchAll(new RegExp(`<${p}sheet\\b[^>]*?/?>`, 'g'))) {
    const name = attr(m[0], 'name');
    const rid = attr(m[0], 'r:id');
    if (!name || !rid || !relTarget[rid]) continue;
    const t = relTarget[rid];
    out[name] = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
  }
  return out;
}

export async function listSheetNames(workbook: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(workbook);
  return Object.keys(await sheetPaths(zip));
}

export async function readCfrValues(workbook: Buffer, sheets: string[]): Promise<CfrValue[]> {
  const zip = await JSZip.loadAsync(workbook);
  const paths = await sheetPaths(zip);
  const out: CfrValue[] = [];
  for (const sheet of sheets) {
    const path = paths[sheet];
    if (!path) continue;
    const xml = await zip.file(path)!.async('string');
    const p = detectPrefix(xml);
    const codeRe = new RegExp(
      `<${p}c\\b[^>]*\\br="C(\\d+)"[^>]*>(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*(\\d+)\\s*</${p}v>`,
      'g'
    );
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(xml))) {
      const row = parseInt(m[1], 10);
      const cfrCode = parseInt(m[2], 10);
      const eRe = new RegExp(
        `<${p}c\\b[^>]*\\br="E${row}"[^>]*>(?:<${p}f\\b[^>]*?(?:/>|>[^<]*</${p}f>))?<${p}v>\\s*(-?[\\d.eE+]+)\\s*</${p}v>`
      );
      const em = xml.match(eRe);
      out.push({ sheet, cfrCode, row, value: em ? parseFloat(em[1]) : null });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/template-reader.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/template-reader.ts tests/template-reader.test.ts
git commit -m "feat: CfR template reader (code/value triples) for prior returns and replay"
```

---

### Task 5: Domain types + ported mapping layer

**Files:**
- Create: `src/domain.ts`, `src/mapping.ts`
- Test: `tests/mapping.test.ts`

Adaptations from `maltaCit.mapping.ts`: (a) figures come from our `EtbAccount` (no Prisma/engagement); (b) statement split is derived FROM the confirmed mapping (raw ETBs carry no FS classification), so net profit = −(sum of amounts mapped to `Income`); (c) `proposeMapping` gains a prior-year code-set bias.

- [ ] **Step 1: Write `src/domain.ts`**

```ts
/** Standalone domain types. Adapted from maltaCit.domain.ts (no engagement/Prisma). */

export type CfrSheet = 'B_Sheet' | 'Income';

/** One normalized ETB line parsed from the raw client Excel. Dr +, Cr −. */
export interface EtbAccount {
  accountCode: string;
  accountName: string;
  /** Current-year adjusted/final balance — feeds the return. */
  cyBalance: number;
  /** Prior-year comparative balance (used for the prior-return cross-check). */
  pyBalance: number | null;
}

export interface MappingRule {
  ledgerCode?: string;
  ledgerNameMatch?: string;
  cfrCode: number;
  sheet: CfrSheet;
}

export interface MappingProfile {
  rules: MappingRule[];
}

export interface ProposedRule {
  ledgerCode: string;
  cfrCode: number;
  sheet: CfrSheet;
  confidence: number;
}

/** An interview answer that lands on the return as a deterministic figure. */
export interface InterviewFill {
  /** Anchor id resolved via template-map, or null = manual entry (listed in summary). */
  anchorId: string | null;
  amount: number;
  label: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { applyMapping, proposeMapping, netProfitFromMapping } from '../src/mapping';
import type { EtbAccount, MappingProfile } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: 4000 },
  { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
  { accountCode: '7100', accountName: 'Audit fees', cyBalance: 1500, pyBalance: 1400 },
  { accountCode: '9999', accountName: 'Mystery suspense', cyBalance: 10, pyBalance: null },
];

describe('mapping', () => {
  it('applies a confirmed profile, aggregates by code, surfaces unmapped', () => {
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        { ledgerNameMatch: 'audit', cfrCode: 6173, sheet: 'Income' },
      ],
    };
    const fill = applyMapping(ETB, profile);
    expect(fill.codeCells).toContainEqual({ sheet: 'B_Sheet', cfrCode: 2150, amount: 5000 });
    expect(fill.codeCells).toContainEqual({ sheet: 'Income', cfrCode: 5000, amount: -80000 });
    expect(fill.unmappedAccounts).toEqual([
      { code: '9999', name: 'Mystery suspense', balance: 10 },
    ]);
    // net profit derived from Income-mapped lines: -(-80000 + 1500) = 78500
    expect(netProfitFromMapping(fill)).toBe(78500);
    expect(fill.directCells).toContainEqual({ sheet: 'p3', ref: 'E6', value: 78500 });
  });

  it('heuristic proposal maps recognizable names and prefers prior-year codes', () => {
    const proposed = proposeMapping(ETB, { priorYearCodes: new Set([2155]) });
    const bank = proposed.rules.find((r) => r.ledgerCode === '1200');
    expect(bank).toBeDefined();
    expect(bank!.sheet).toBe('B_Sheet');
    // no proposal for the suspense account — must be left for the human
    expect(proposed.rules.find((r) => r.ledgerCode === '9999')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/mapping.ts`** — port `maltaCit.mapping.ts` with these changes: import types from `./domain`; `applyMapping(accounts: EtbAccount[], profile)` uses `cyBalance`; add `netProfitFromMapping`; keep the full `PROPOSALS` heuristic table from the original verbatim (all ~20 rules including the VD-638 guards); extend `proposeMapping` signature.

```ts
/**
 * CoA -> CfR-code mapping. Ported from maltaCit.mapping.ts (feat/malta-cit-tax-return),
 * adapted for raw-ETB input: statement routing comes from the confirmed mapping itself.
 * No figure is invented here — amounts come straight from the ETB.
 */
import type {
  EtbAccount,
  MappingProfile,
  MappingRule,
  ProposedRule,
  CfrSheet,
} from './domain';
import type { CfrCodeCell, CfrDirectCell } from './template-writer';

export interface MappedFill {
  codeCells: CfrCodeCell[];
  directCells: CfrDirectCell[];
  unmappedAccounts: Array<{ code: string; name: string; balance: number }>;
  /** ledgerCode -> applied rule (provenance for the computation summary). */
  applied: Map<string, MappingRule>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function matchRule(acc: EtbAccount, rules: MappingRule[]): MappingRule | undefined {
  const byCode = rules.find((r) => r.ledgerCode && r.ledgerCode === acc.accountCode);
  if (byCode) return byCode;
  const name = acc.accountName.toLowerCase();
  return rules.find((r) => r.ledgerNameMatch && name.includes(r.ledgerNameMatch.toLowerCase()));
}

/** Net profit derived from lines mapped to Income (income Cr/−, expenses Dr/+). */
export function netProfitFromMapping(fill: Pick<MappedFill, 'codeCells'>): number {
  const plSum = fill.codeCells
    .filter((c) => c.sheet === 'Income')
    .reduce((acc, c) => acc + c.amount, 0);
  return round2(-plSum);
}

export function applyMapping(accounts: EtbAccount[], profile: MappingProfile): MappedFill {
  const byCode = new Map<number, { sheet: CfrSheet; amount: number }>();
  const unmappedAccounts: MappedFill['unmappedAccounts'] = [];
  const applied = new Map<string, MappingRule>();

  for (const acc of accounts) {
    const rule = matchRule(acc, profile.rules);
    if (!rule) {
      unmappedAccounts.push({ code: acc.accountCode, name: acc.accountName, balance: acc.cyBalance });
      continue;
    }
    applied.set(acc.accountCode, rule);
    const cur = byCode.get(rule.cfrCode);
    if (cur) cur.amount += acc.cyBalance;
    else byCode.set(rule.cfrCode, { sheet: rule.sheet, amount: acc.cyBalance });
  }

  const codeCells: CfrCodeCell[] = [...byCode.entries()].map(([cfrCode, v]) => ({
    sheet: v.sheet,
    cfrCode,
    amount: round2(v.amount),
  }));
  const fillNoDirect = { codeCells };
  const directCells: CfrDirectCell[] = [
    { sheet: 'p3', ref: 'E6', value: netProfitFromMapping(fillNoDirect) },
  ];
  return { codeCells, directCells, unmappedAccounts, applied };
}

// --- Heuristic proposal (stand-in / fallback for the AI proposal; human confirms) ---
// PORT THE FULL `PROPOSALS` TABLE FROM maltaCit.mapping.ts VERBATIM HERE
// (all rules including the VD-638 cash-vs-loan guard and cost-of-sales-before-revenue
// ordering). Do not retype from memory — copy from the source file.
const PROPOSALS: Array<{ kw: RegExp; cfrCode: number; sheet: CfrSheet; confidence: number }> = [
  /* copied verbatim from
     C:\Users\user\Downloads\vacei-stack\_reint_be\src\modules\service\tax\malta-cit\maltaCit.mapping.ts
     lines 100-161 */
];

export interface ProposalContext {
  /** CfR codes present on the client's prior-year return — small confidence boost. */
  priorYearCodes?: Set<number>;
}

export function proposeMapping(
  accounts: EtbAccount[],
  ctx: ProposalContext = {}
): { rules: ProposedRule[] } {
  const rules: ProposedRule[] = [];
  for (const acc of accounts) {
    const name = (acc.accountName || '').toLowerCase();
    const hit = PROPOSALS.find((p) => p.kw.test(name));
    if (!hit) continue;
    const boost = ctx.priorYearCodes?.has(hit.cfrCode) ? 0.05 : 0;
    rules.push({
      ledgerCode: acc.accountCode,
      cfrCode: hit.cfrCode,
      sheet: hit.sheet,
      confidence: Math.min(0.99, hit.confidence + boost),
    });
  }
  return { rules };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mapping.test.ts`
Expected: 2 passed. (If the bank rule fails, verify the PROPOSALS table was copied completely.)

- [ ] **Step 6: Commit**

```bash
git add src/domain.ts src/mapping.ts tests/mapping.test.ts
git commit -m "feat: port mapping layer, derive statement split from confirmed mapping"
```

---

### Task 6: Raw ETB parser

Real ETBs vary: header rows at arbitrary positions, either a single balance column or Dr/Cr pairs, CY and PY column groups. Strategy: scan the first 30 rows for a header row (a row containing a code-ish and a name-ish label plus at least one amount-ish label); classify columns by header keywords; net Dr/Cr pairs to a signed balance (Dr +, Cr −).

**Files:**
- Create: `src/etb-parser.ts`
- Test: `tests/etb-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseEtb } from '../src/etb-parser';
import { syntheticEtbXlsx } from './helpers/synthetic';

describe('parseEtb', () => {
  it('parses a code/name/debit/credit layout with a preamble row', () => {
    const buf = syntheticEtbXlsx([
      ['Client X — Extended Trial Balance FY2025', null, null, null],
      ['Code', 'Account Name', 'Debit', 'Credit'],
      ['1200', 'Bank current account', 5000, null],
      ['4000', 'Sales', null, 80000],
      [null, 'Totals', 5000, 80000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts).toEqual([
      { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: null },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: null },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('parses single-balance + prior-year columns', () => {
    const buf = syntheticEtbXlsx([
      ['N/C', 'Name', 'Final Balance', 'Prior Year'],
      ['7100', 'Audit fees', 1500, 1400],
      ['4000', 'Turnover', -80000, -70000],
    ]);
    const res = parseEtb(buf);
    expect(res.accounts[0]).toEqual({
      accountCode: '7100',
      accountName: 'Audit fees',
      cyBalance: 1500,
      pyBalance: 1400,
    });
  });

  it('rejects a file where no header row can be found', () => {
    const buf = syntheticEtbXlsx([['just', 'some', 'text'], ['more', 'noise', 1]]);
    expect(() => parseEtb(buf)).toThrow(/could not locate an ETB header row/i);
  });

  it('warns when the ETB does not balance to zero', () => {
    const buf = syntheticEtbXlsx([
      ['Code', 'Account', 'Balance'],
      ['1200', 'Bank', 5000],
      ['4000', 'Sales', -4000],
    ]);
    const res = parseEtb(buf);
    expect(res.warnings.some((w) => /does not balance/i.test(w))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/etb-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/etb-parser.ts`**

```ts
/**
 * Parses raw client ETB spreadsheets (varying real-world layouts) into EtbAccount[].
 * Sign convention: Dr +, Cr −. Nothing is guessed silently: unparseable files throw,
 * imbalances and skipped rows come back as warnings for the preparer to see.
 */
import * as XLSX from 'xlsx';
import type { EtbAccount } from './domain';

export interface ParsedEtb {
  accounts: EtbAccount[];
  warnings: string[];
  headerRow: number;
  sheetName: string;
}

type ColKind = 'code' | 'name' | 'debit' | 'credit' | 'balance' | 'pyBalance' | 'pyDebit' | 'pyCredit';

const HEADER_PATTERNS: Array<{ kind: ColKind; re: RegExp }> = [
  { kind: 'pyDebit', re: /(prior|previous|py|comparat).*(debit|dr)|(debit|dr).*(prior|previous|py)/i },
  { kind: 'pyCredit', re: /(prior|previous|py|comparat).*(credit|cr)|(credit|cr).*(prior|previous|py)/i },
  { kind: 'pyBalance', re: /prior|previous|\bpy\b|comparat|last year/i },
  { kind: 'debit', re: /^debits?$|\bdr\b/i },
  { kind: 'credit', re: /^credits?$|\bcr\b/i },
  { kind: 'balance', re: /final|adjusted|closing|balance|amount|\btb\b|current/i },
  { kind: 'code', re: /^(a\/?c|n\/?c|nominal|acc(ount)?)?\s*(code|no|number|ref)\.?$|^code$|^n\/c$/i },
  { kind: 'name', re: /name|description|account|narrative|details/i },
];

function classify(header: string): ColKind | null {
  const h = header.trim();
  if (!h) return null;
  for (const p of HEADER_PATTERNS) if (p.re.test(h)) return p.kind;
  return null;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[€,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }
  return null;
}

export function parseEtb(buffer: Buffer): ParsedEtb {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let best: { score: number; sheet: string; row: number; cols: Map<number, ColKind> } | null = null;

  for (const sheetName of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null,
    });
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const cols = new Map<number, ColKind>();
      (rows[r] ?? []).forEach((cell, c) => {
        if (typeof cell === 'string') {
          const kind = classify(cell);
          if (kind && ![...cols.values()].includes(kind)) cols.set(c, kind);
        }
      });
      const kinds = new Set(cols.values());
      const hasAmount = kinds.has('balance') || (kinds.has('debit') && kinds.has('credit'));
      const hasName = kinds.has('name') || kinds.has('code');
      if (hasAmount && hasName) {
        const score = cols.size;
        if (!best || score > best.score) best = { score, sheet: sheetName, row: r, cols };
      }
    }
  }
  if (!best) throw new Error('Could not locate an ETB header row in any sheet (looked in first 30 rows).');

  const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[best.sheet], {
    header: 1,
    raw: true,
    defval: null,
  });
  const col = (kind: ColKind): number | null => {
    for (const [c, k] of best!.cols) if (k === kind) return c;
    return null;
  };
  const cCode = col('code');
  const cName = col('name');
  const cDr = col('debit');
  const cCr = col('credit');
  const cBal = col('balance');
  const cPy = col('pyBalance');
  const cPyDr = col('pyDebit');
  const cPyCr = col('pyCredit');

  const warnings: string[] = [];
  const accounts: EtbAccount[] = [];
  for (let r = best.row + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = cName != null ? String(row[cName] ?? '').trim() : '';
    const codeRaw = cCode != null ? row[cCode] : null;
    const code = codeRaw != null ? String(codeRaw).trim() : '';
    if (!name && !code) continue;
    if (/^total/i.test(name) || /^total/i.test(code)) continue;

    let cy: number | null = null;
    if (cBal != null) cy = toNumber(row[cBal]);
    else if (cDr != null && cCr != null) {
      const dr = toNumber(row[cDr]) ?? 0;
      const cr = toNumber(row[cCr]) ?? 0;
      cy = dr - cr;
      if (toNumber(row[cDr]) === null && toNumber(row[cCr]) === null) cy = null;
    }
    if (cy === null) {
      if (name || code) warnings.push(`Row ${r + 1} ("${name || code}") skipped: no numeric balance.`);
      continue;
    }
    let py: number | null = null;
    if (cPy != null) py = toNumber(row[cPy]);
    else if (cPyDr != null && cPyCr != null) {
      const d = toNumber(row[cPyDr]);
      const c = toNumber(row[cPyCr]);
      py = d === null && c === null ? null : (d ?? 0) - (c ?? 0);
    }
    accounts.push({ accountCode: code || name, accountName: name || code, cyBalance: cy, pyBalance: py });
  }

  const sum = accounts.reduce((a, x) => a + x.cyBalance, 0);
  if (Math.abs(sum) > 1) warnings.push(`ETB does not balance: net ${sum.toFixed(2)} (should be 0).`);
  if (accounts.length === 0) throw new Error('Header row found but no account rows could be parsed.');
  return { accounts, warnings, headerRow: best.row, sheetName: best.sheet };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/etb-parser.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add the real-fixture smoke test to the same file (skips without fixtures)**

```ts
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.join(__dirname, '..', 'fixtures', 'etb');
const real = fs.existsSync(FIX)
  ? fs.readdirSync(FIX, { recursive: true, encoding: 'utf8' }).filter((f) => /\.xlsx?$/i.test(f))
  : [];

describe.skipIf(real.length === 0)('parseEtb on real corpus ETBs', () => {
  for (const f of real) {
    it(`parses ${f} and balances`, () => {
      const res = parseEtb(fs.readFileSync(path.join(FIX, f)));
      expect(res.accounts.length).toBeGreaterThan(5);
    });
  }
});
```

- [ ] **Step 6: Run tests, then commit**

Run: `npx vitest run tests/etb-parser.test.ts`
Expected: 4 passed, real-corpus suite skipped (or passing if fixtures present).

```bash
git add src/etb-parser.ts tests/etb-parser.test.ts
git commit -m "feat: raw ETB Excel parser with header detection and balance warnings"
```

---

### Task 7: FS tie-check

Keep it deterministic and simple: the preparer's FS gives net profit and total assets; we verify the mapped ETB reproduces them. Accept the two figures either parsed from an FS Excel (best-effort label search) or typed by the preparer in the UI (always available fallback).

**Files:**
- Create: `src/fs-tie-check.ts`
- Test: `tests/fs-tie-check.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { extractFsFigures, tieCheck } from '../src/fs-tie-check';
import { syntheticEtbXlsx } from './helpers/synthetic';

describe('fs-tie-check', () => {
  it('extracts net profit and total assets from an FS workbook by label', () => {
    const buf = syntheticEtbXlsx([
      ['Statement of comprehensive income', null],
      ['Profit for the year', 78500],
      ['Statement of financial position', null],
      ['Total assets', 120000],
    ]);
    const figs = extractFsFigures(buf);
    expect(figs.netProfit).toBe(78500);
    expect(figs.totalAssets).toBe(120000);
  });

  it('passes when ETB-derived figures tie within €1', () => {
    const res = tieCheck({ netProfit: 78500, totalAssets: 120000 }, { netProfit: 78500.4, totalAssets: 120000 });
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('reports differences when figures do not tie', () => {
    const res = tieCheck({ netProfit: 78500, totalAssets: 120000 }, { netProfit: 70000, totalAssets: 120000 });
    expect(res.ok).toBe(false);
    expect(res.issues[0]).toMatch(/net profit/i);
    expect(res.issues[0]).toContain('8500');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fs-tie-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/fs-tie-check.ts`**

```ts
/**
 * FS tie-check: does the mapped ETB reproduce the signed FS?
 * v1 compares two headline figures — net profit and total assets. Figures come
 * from a best-effort label scan of the FS Excel, or the preparer types them.
 * A failed tie never blocks silently: it produces explicit warnings.
 */
import * as XLSX from 'xlsx';

export interface FsFigures {
  netProfit: number | null;
  totalAssets: number | null;
}

const NET_PROFIT_RE = /profit\s*(?:\/?\s*\(?loss\)?)?\s*for the (?:year|period)|net profit/i;
const TOTAL_ASSETS_RE = /^total assets$/i;

export function extractFsFigures(buffer: Buffer): FsFigures {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  let netProfit: number | null = null;
  let totalAssets: number | null = null;
  for (const name of wb.SheetNames) {
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    for (const row of rows) {
      const label = row.find((c) => typeof c === 'string') as string | undefined;
      if (!label) continue;
      const firstNum = row.find((c) => typeof c === 'number') as number | undefined;
      if (firstNum === undefined) continue;
      if (netProfit === null && NET_PROFIT_RE.test(label.trim())) netProfit = firstNum;
      if (totalAssets === null && TOTAL_ASSETS_RE.test(label.trim())) totalAssets = firstNum;
    }
  }
  return { netProfit, totalAssets };
}

export interface TieResult {
  ok: boolean;
  issues: string[];
}

const TOL = 1; // €1 tolerance for rounding

export function tieCheck(fs: FsFigures, etbDerived: FsFigures): TieResult {
  const issues: string[] = [];
  if (fs.netProfit !== null && etbDerived.netProfit !== null) {
    const d = Math.abs(fs.netProfit - etbDerived.netProfit);
    if (d > TOL)
      issues.push(
        `Net profit does not tie: FS €${fs.netProfit.toFixed(2)} vs ETB-derived €${etbDerived.netProfit.toFixed(2)} (difference €${d.toFixed(2)}).`
      );
  }
  if (fs.totalAssets !== null && etbDerived.totalAssets !== null) {
    const d = Math.abs(fs.totalAssets - etbDerived.totalAssets);
    if (d > TOL)
      issues.push(
        `Total assets do not tie: FS €${fs.totalAssets.toFixed(2)} vs ETB-derived €${etbDerived.totalAssets.toFixed(2)} (difference €${d.toFixed(2)}).`
      );
  }
  return { ok: issues.length === 0, issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fs-tie-check.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/fs-tie-check.ts tests/fs-tie-check.test.ts
git commit -m "feat: FS tie-check (net profit + total assets vs mapped ETB)"
```

---

### Task 8: Prior-return intake + prior-year cross-check

Two deterministic capabilities: (1) read the prior return's code set/values (feeds mapping bias + interview pre-answers); (2) cross-check — mapping the ETB's PY balances with the proposed profile should reproduce the prior return's filed values; mismatches indicate wrong mapping and are surfaced per code.

**Files:**
- Create: `src/prior-return.ts`, `src/template-map.ts`
- Test: `tests/prior-return.test.ts`

- [ ] **Step 1: Write `src/template-map.ts`** (anchors start empty; the survey script in Task 12 populates them as real templates are examined)

```ts
/**
 * Anchors into the CfR template beyond the B_Sheet/Income code rows.
 * Populated by running `npm run survey -- <path-to-real-template>` against the
 * firm's current-year template and recording what it reports. An anchor that is
 * null means "not yet surveyed": interview answers targeting it are collected,
 * shown on the computation summary as MANUAL ENTRY items, and never guessed.
 */
export interface DirectAnchor {
  sheet: string;
  ref: string;
}

export const ANCHORS: Record<string, DirectAnchor | null> = {
  netProfitPerAccounts: { sheet: 'p3', ref: 'E6' }, // known from the ported branch
  lossesBroughtForward: null,
  capitalAllowancesTotal: null,
  depreciationAddBack: null,
  finesPenaltiesAddBack: null,
  donationsAddBack: null,
  entertainmentAddBack: null,
  unrealizedFxAddBack: null,
  dividendsExemptPE: null,
};
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readPriorReturn, priorYearCrossCheck } from '../src/prior-return';
import { syntheticCfrWorkbook } from './helpers/synthetic';
import type { EtbAccount, MappingProfile } from '../src/domain';

describe('prior-return', () => {
  it('extracts the code set and values from a filed prior return', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 4000 }],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const info = await readPriorReturn(prior);
    expect(info.codes.has(2150)).toBe(true);
    expect(info.values).toContainEqual({ sheet: 'B_Sheet', cfrCode: 2150, row: 10, value: 4000 });
  });

  it('cross-check passes when PY balances mapped reproduce the prior return', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 4000 }],
      income: [{ row: 5, code: 5000, value: -70000 }],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      ],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([]);
    expect(res.checkedCodes).toBe(2);
  });

  it('cross-check reports per-code mismatches', async () => {
    const prior = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 9999 }],
      income: [],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: 4000 },
    ];
    const profile: MappingProfile = {
      rules: [{ ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' }],
    };
    const res = await priorYearCrossCheck(prior, etb, profile);
    expect(res.mismatches).toEqual([
      { sheet: 'B_Sheet', cfrCode: 2150, priorReturnValue: 9999, mappedPyValue: 4000 },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/prior-return.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/prior-return.ts`**

```ts
/**
 * Prior-year filed return intake. Deterministic extraction only:
 *  - which CfR codes the client used last year (mapping bias + review context)
 *  - filed values per code (prior-year cross-check)
 * Continuity balances beyond code rows (losses b/f, TRA5 TWDVs, tax accounts)
 * are pre-answered in the interview ONLY where template-map anchors exist.
 */
import { readCfrValues, type CfrValue } from './template-reader';
import type { EtbAccount, MappingProfile } from './domain';
import { applyMapping } from './mapping';

const CODE_SHEETS = ['B_Sheet', 'Income'];

export interface PriorReturnInfo {
  codes: Set<number>;
  values: CfrValue[];
}

export async function readPriorReturn(buffer: Buffer): Promise<PriorReturnInfo> {
  const values = await readCfrValues(buffer, CODE_SHEETS);
  return { codes: new Set(values.map((v) => v.cfrCode)), values };
}

export interface CrossCheckMismatch {
  sheet: string;
  cfrCode: number;
  priorReturnValue: number;
  mappedPyValue: number;
}

export interface CrossCheckResult {
  checkedCodes: number;
  mismatches: CrossCheckMismatch[];
}

const TOL = 1;

/**
 * Map the ETB's PRIOR-year balances with the proposed profile; the aggregates
 * should reproduce the prior return's filed values. Mismatches = mapping smells.
 */
export async function priorYearCrossCheck(
  priorReturn: Buffer,
  etb: EtbAccount[],
  profile: MappingProfile
): Promise<CrossCheckResult> {
  const prior = await readPriorReturn(priorReturn);
  const pyAsCy: EtbAccount[] = etb
    .filter((a) => a.pyBalance !== null)
    .map((a) => ({ ...a, cyBalance: a.pyBalance as number, pyBalance: null }));
  const mapped = applyMapping(pyAsCy, profile);

  const mismatches: CrossCheckMismatch[] = [];
  let checked = 0;
  for (const cell of mapped.codeCells) {
    const filed = prior.values.find((v) => v.sheet === cell.sheet && v.cfrCode === cell.cfrCode);
    if (!filed || filed.value === null) continue;
    checked++;
    if (Math.abs(filed.value - cell.amount) > TOL) {
      mismatches.push({
        sheet: cell.sheet,
        cfrCode: cell.cfrCode,
        priorReturnValue: filed.value,
        mappedPyValue: cell.amount,
      });
    }
  }
  return { checkedCodes: checked, mismatches };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/prior-return.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/prior-return.ts src/template-map.ts tests/prior-return.test.ts
git commit -m "feat: prior-return intake + deterministic prior-year mapping cross-check"
```

---

### Task 9: Tax-data interview engine

A catalog of conditional, Act-grounded questions. Triggers fire from ETB account names and mapped codes; pre-answers come from deterministic sources only (ETB balances, prior-return values). Confirmed answers become `InterviewFill`s (anchored writes or manual-entry items).

**Files:**
- Create: `src/interview.ts`
- Test: `tests/interview.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildInterview, fillsFromAnswers } from '../src/interview';
import type { EtbAccount } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '8000', accountName: 'Depreciation charge', cyBalance: 3000, pyBalance: 2500 },
  { accountCode: '8100', accountName: 'Fines and penalties', cyBalance: 200, pyBalance: null },
  { accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: -70000 },
];

describe('interview', () => {
  it('triggers depreciation add-back with the ETB figure pre-answered', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    const dep = iv.questions.find((q) => q.id === 'depreciationAddBack');
    expect(dep).toBeDefined();
    expect(dep!.preAnswer).toBe(3000);
    expect(dep!.legalBasis).toMatch(/Cap\. 123/);
  });

  it('triggers fines add-back and always asks losses b/f when no prior return', () => {
    const iv = buildInterview(ETB, { hasPriorReturn: false });
    expect(iv.questions.some((q) => q.id === 'finesPenaltiesAddBack')).toBe(true);
    expect(iv.questions.some((q) => q.id === 'lossesBroughtForward')).toBe(true);
  });

  it('does not trigger questions with no basis in the ETB', () => {
    const iv = buildInterview(
      [{ accountCode: '4000', accountName: 'Sales', cyBalance: -80000, pyBalance: null }],
      { hasPriorReturn: false }
    );
    expect(iv.questions.some((q) => q.id === 'depreciationAddBack')).toBe(false);
  });

  it('converts confirmed answers into anchored or manual fills, skipping zeros', () => {
    const fills = fillsFromAnswers({ depreciationAddBack: 3000, lossesBroughtForward: 0 });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ amount: 3000, label: expect.stringMatching(/depreciation/i) });
    // anchor not yet surveyed -> manual entry
    expect(fills[0].anchorId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/interview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/interview.ts`**

```ts
/**
 * Tax-data interview: structured, conditional questions grounded in the Income
 * Tax Act (Cap. 123). Pre-answers are deterministic (ETB balances, prior-return
 * values) — never AI-invented. The preparer confirms/edits every answer; only
 * confirmed answers produce figures.
 */
import type { EtbAccount, InterviewFill } from './domain';
import { ANCHORS } from './template-map';

export interface Question {
  id: string;
  text: string;
  /** Statutory grounding shown to the preparer. */
  legalBasis: string;
  kind: 'amount' | 'yesno';
  /** Deterministic pre-answer (ETB-derived) or null = preparer must supply. */
  preAnswer: number | null;
  /** Which ETB accounts triggered this question (provenance). */
  triggeredBy: string[];
}

export interface Interview {
  questions: Question[];
}

interface Trigger {
  id: string;
  nameRe: RegExp;
  text: string;
  legalBasis: string;
  /** Pre-answer = sum of matching accounts' |cyBalance| (expenses are Dr +). */
  sumMatches: boolean;
}

const TRIGGERS: Trigger[] = [
  {
    id: 'depreciationAddBack',
    nameRe: /deprecia|amortis|amortiz/i,
    text: 'Depreciation/amortisation charged in the accounts is not deductible; it is added back and capital allowances are claimed instead. Confirm the add-back amount.',
    legalBasis: 'Cap. 123 Art. 14(1)(f) & Deduction (Wear and Tear) Rules — book depreciation replaced by statutory capital allowances.',
    sumMatches: true,
  },
  {
    id: 'finesPenaltiesAddBack',
    nameRe: /fine|penalt/i,
    text: 'Fines and penalties are not wholly and exclusively incurred in the production of income. Confirm the add-back amount.',
    legalBasis: 'Cap. 123 Art. 14(1) — deduction limited to outgoings wholly and exclusively incurred in the production of the income.',
    sumMatches: true,
  },
  {
    id: 'donationsAddBack',
    nameRe: /donation|sponsor/i,
    text: 'Donations/sponsorships are generally not deductible unless under an approved scheme. Confirm the non-deductible amount.',
    legalBasis: 'Cap. 123 Art. 14(1) wholly-and-exclusively test; approved-scheme exceptions per subsidiary legislation.',
    sumMatches: true,
  },
  {
    id: 'entertainmentAddBack',
    nameRe: /entertain|hospitality/i,
    text: 'Business entertainment is typically non-deductible in part or whole. Confirm the add-back amount.',
    legalBasis: 'Cap. 123 Art. 14(1) wholly-and-exclusively test as applied to entertainment expenditure.',
    sumMatches: true,
  },
  {
    id: 'unrealizedFxAddBack',
    nameRe: /unrealis|unrealiz|exchange (?:gain|loss|difference)/i,
    text: 'Unrealised exchange differences are not taxable/deductible until realised. Confirm the adjustment amount.',
    legalBasis: 'Cap. 123 Arts. 4 & 14 — income/deductions arise when realised (derived), not on retranslation.',
    sumMatches: true,
  },
  {
    id: 'dividendsExemptPE',
    nameRe: /dividend/i,
    text: 'Dividend income may qualify for the participation exemption. Confirm the exempt amount (0 if not applicable).',
    legalBasis: 'Cap. 123 Art. 12(1)(u) — participation exemption for qualifying holdings.',
    sumMatches: true,
  },
];

export interface InterviewContext {
  hasPriorReturn: boolean;
  /** Deterministic pre-answer for losses b/f if extracted from an anchored prior return. */
  priorLossesBroughtForward?: number | null;
}

export function buildInterview(etb: EtbAccount[], ctx: InterviewContext): Interview {
  const questions: Question[] = [];
  for (const t of TRIGGERS) {
    const hits = etb.filter((a) => t.nameRe.test(a.accountName));
    if (hits.length === 0) continue;
    const sum = hits.reduce((acc, a) => acc + Math.abs(a.cyBalance), 0);
    questions.push({
      id: t.id,
      text: t.text,
      legalBasis: t.legalBasis,
      kind: 'amount',
      preAnswer: t.sumMatches ? Math.round(sum * 100) / 100 : null,
      triggeredBy: hits.map((a) => a.accountCode),
    });
  }
  // Always asked — continuity items.
  questions.push({
    id: 'lossesBroughtForward',
    text: 'Unabsorbed tax losses brought forward from prior years (0 if none).',
    legalBasis: 'Cap. 123 Art. 14(1)(g) — carry-forward of losses incurred in a trade etc.',
    kind: 'amount',
    preAnswer: ctx.priorLossesBroughtForward ?? null,
    triggeredBy: [],
  });
  questions.push({
    id: 'capitalAllowancesTotal',
    text: 'Total capital allowances claimed for the year (per the capital allowances computation / TRA5).',
    legalBasis: 'Cap. 123 Art. 14(1)(f)(j) & Wear and Tear Rules — statutory allowances on plant, machinery and industrial buildings.',
    kind: 'amount',
    preAnswer: null,
    triggeredBy: [],
  });
  return { questions };
}

const LABELS: Record<string, string> = {
  depreciationAddBack: 'Add back: depreciation/amortisation',
  finesPenaltiesAddBack: 'Add back: fines and penalties',
  donationsAddBack: 'Add back: donations/sponsorships',
  entertainmentAddBack: 'Add back: entertainment',
  unrealizedFxAddBack: 'Adjust: unrealised exchange differences',
  dividendsExemptPE: 'Exempt: participation exemption dividends',
  lossesBroughtForward: 'Deduct: losses brought forward',
  capitalAllowancesTotal: 'Deduct: capital allowances',
};

/** Confirmed answers -> deterministic fills. Zero answers produce nothing. */
export function fillsFromAnswers(answers: Record<string, number>): InterviewFill[] {
  const fills: InterviewFill[] = [];
  for (const [id, amount] of Object.entries(answers)) {
    if (!amount) continue;
    const anchor = ANCHORS[id] ?? null;
    fills.push({ anchorId: anchor ? id : null, amount, label: LABELS[id] ?? id });
  }
  return fills;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/interview.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/interview.ts tests/interview.test.ts
git commit -m "feat: Act-grounded conditional tax-data interview engine"
```

---

### Task 10: Computation summary (HTML workings)

**Files:**
- Create: `src/computation-summary.ts`
- Test: `tests/computation-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderComputationSummary } from '../src/computation-summary';

describe('computation summary', () => {
  it('renders profit, adjustments, manual-entry flags and provenance', () => {
    const html = renderComputationSummary({
      clientName: 'Test Client Ltd',
      yearOfAssessment: 'YA2026',
      netProfitPerAccounts: 78500,
      fills: [
        { anchorId: null, amount: 3000, label: 'Add back: depreciation/amortisation' },
        { anchorId: 'lossesBroughtForward', amount: 1200, label: 'Deduct: losses brought forward' },
      ],
      mappingRows: [
        { ledger: '4000 Sales', cfrCode: 5000, sheet: 'Income', amount: -80000 },
      ],
      warnings: ['ETB does not balance: net 0.50 (should be 0).'],
      unmatchedCodes: [],
    });
    expect(html).toContain('Test Client Ltd');
    expect(html).toContain('78,500.00');
    expect(html).toContain('MANUAL ENTRY');       // unanchored fill flagged
    expect(html).toContain('depreciation');
    expect(html).toContain('does not balance');
    expect(html).toContain('5000');               // mapping provenance
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/computation-summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/computation-summary.ts`**

```ts
/**
 * Printable computation summary: accounting profit -> adjustments -> chargeable
 * income inputs, with provenance for every line. Pure function of confirmed
 * data; the CfR template remains the authoritative tax computation.
 */
import type { InterviewFill } from './domain';

export interface SummaryInput {
  clientName: string;
  yearOfAssessment: string;
  netProfitPerAccounts: number;
  fills: InterviewFill[];
  mappingRows: Array<{ ledger: string; cfrCode: number; sheet: string; amount: number }>;
  warnings: string[];
  unmatchedCodes: Array<{ sheet: string; cfrCode: number }>;
}

const eur = (n: number) =>
  n.toLocaleString('en-MT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderComputationSummary(input: SummaryInput): string {
  const adj = input.fills
    .map(
      (f) => `<tr><td>${esc(f.label)}</td><td class="num">${eur(f.amount)}</td>
<td>${f.anchorId ? 'written to return' : '<strong>MANUAL ENTRY on return</strong>'}</td></tr>`
    )
    .join('\n');
  const map = input.mappingRows
    .map(
      (m) =>
        `<tr><td>${esc(m.ledger)}</td><td>${m.sheet}</td><td>${m.cfrCode}</td><td class="num">${eur(m.amount)}</td></tr>`
    )
    .join('\n');
  const warn = [...input.warnings, ...input.unmatchedCodes.map((u) => `Unmatched CfR code ${u.cfrCode} on ${u.sheet} — not written.`)]
    .map((w) => `<li>${esc(w)}</li>`)
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Tax computation — ${esc(input.clientName)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:2rem;color:#111}
table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
.num{text-align:right;font-variant-numeric:tabular-nums}h2{margin-top:2rem}
.warn{background:#fff7e6;border:1px solid #e6b800;padding:1rem}</style></head><body>
<h1>Income tax computation workings — ${esc(input.clientName)} (${esc(input.yearOfAssessment)})</h1>
<p>Prepared by the Malta Tax Return Generator. Figures are deterministic (ETB + confirmed answers);
the CfR return template computes the tax. This document shows the workings and provenance.</p>
<h2>Profit per accounts</h2>
<table><tr><td>Net profit/(loss) per financial statements</td><td class="num">${eur(input.netProfitPerAccounts)}</td><td>from mapped ETB (Income lines)</td></tr></table>
<h2>Tax adjustments (confirmed in interview)</h2>
<table><tr><th>Adjustment</th><th>Amount €</th><th>Treatment</th></tr>${adj || '<tr><td colspan="3">None</td></tr>'}</table>
<h2>Account mapping (provenance)</h2>
<table><tr><th>Ledger account</th><th>Sheet</th><th>CfR code</th><th>Amount €</th></tr>${map}</table>
${warn ? `<h2>Warnings</h2><div class="warn"><ul>${warn}</ul></div>` : ''}
</body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/computation-summary.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/computation-summary.ts tests/computation-summary.test.ts
git commit -m "feat: printable computation summary with provenance and manual-entry flags"
```

---

### Task 11: AI mapping proposal (env-gated, heuristic fallback)

Before implementing this task, read the `claude-api` skill (it triggers on any Anthropic SDK work) for current SDK usage. AI proposes mapping rules ONLY (never figures); absent `ANTHROPIC_API_KEY`, `proposeMapping` heuristics are used and the UI badge says "heuristic".

**Files:**
- Create: `src/ai-mapper.ts`
- Test: `tests/ai-mapper.test.ts` (mocked transport — no live API in tests)

- [ ] **Step 1: Add the SDK**

Run: `npm install @anthropic-ai/sdk`

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { proposeMappingAI } from '../src/ai-mapper';
import type { EtbAccount } from '../src/domain';

const ETB: EtbAccount[] = [
  { accountCode: '1200', accountName: 'Bank current account', cyBalance: 5000, pyBalance: null },
];

describe('ai-mapper', () => {
  it('falls back to heuristics when no API key is configured', async () => {
    const res = await proposeMappingAI(ETB, {}, { apiKey: undefined });
    expect(res.source).toBe('heuristic');
    expect(res.rules.length).toBeGreaterThan(0);
  });

  it('parses a valid model response into proposed rules', async () => {
    const fake = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            rules: [{ ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet', confidence: 0.97 }],
          }),
        },
      ],
    });
    const res = await proposeMappingAI(ETB, {}, { apiKey: 'test', createMessage: fake });
    expect(res.source).toBe('ai');
    expect(res.rules[0]).toMatchObject({ ledgerCode: '1200', cfrCode: 2150 });
  });

  it('falls back to heuristics when the model returns malformed JSON', async () => {
    const fake = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] });
    const res = await proposeMappingAI(ETB, {}, { apiKey: 'test', createMessage: fake });
    expect(res.source).toBe('heuristic');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/ai-mapper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/ai-mapper.ts`** (consult claude-api skill for the exact SDK call shape and current model id before writing; structure below)

```ts
/**
 * AI-proposed CoA -> CfR-code mapping. PROPOSAL ONLY: the preparer confirms
 * every rule; figures never come from the model. Falls back to the heuristic
 * table when unconfigured or on any parse/API failure.
 * Grounding: prior-year code set + firm-corpus example mappings in the prompt.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { EtbAccount, ProposedRule } from './domain';
import { proposeMapping, type ProposalContext } from './mapping';

export interface AiMapperOptions {
  apiKey?: string;
  model?: string;
  /** Test seam: injected message-create function. */
  createMessage?: (req: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

export interface AiProposal {
  rules: ProposedRule[];
  source: 'ai' | 'heuristic';
}

const SYSTEM = `You map Maltese company ledger accounts to official CfR corporate tax return account codes
(1000/2000/3000-series balance sheet on sheet "B_Sheet", 5000/6000/7000-series P&L on sheet "Income").
Reply with JSON only: {"rules":[{"ledgerCode":string,"cfrCode":number,"sheet":"B_Sheet"|"Income","confidence":number}]}
Omit any account you are not confident about — a human tax preparer reviews and completes the mapping.
Never invent amounts; you only classify accounts.`;

export async function proposeMappingAI(
  accounts: EtbAccount[],
  ctx: ProposalContext,
  opts: AiMapperOptions = {}
): Promise<AiProposal> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fallback = (): AiProposal => ({ rules: proposeMapping(accounts, ctx).rules, source: 'heuristic' });
  if (!apiKey) return fallback();

  try {
    const create =
      opts.createMessage ??
      (async (req: unknown) => {
        const client = new Anthropic({ apiKey });
        return client.messages.create(req as never) as never;
      });
    const priorNote = ctx.priorYearCodes?.size
      ? `Codes used on this client's prior-year return (prefer these where sensible): ${[...ctx.priorYearCodes].join(', ')}.`
      : '';
    const res = await create({
      model: opts.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-fable-5',
      max_tokens: 2000,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${priorNote}\nAccounts:\n${accounts
            .map((a) => `${a.accountCode}\t${a.accountName}\t${a.cyBalance >= 0 ? 'Dr' : 'Cr'}`)
            .join('\n')}`,
        },
      ],
    });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed.rules)) return fallback();
    const rules: ProposedRule[] = parsed.rules.filter(
      (r: ProposedRule) =>
        typeof r.ledgerCode === 'string' &&
        typeof r.cfrCode === 'number' &&
        (r.sheet === 'B_Sheet' || r.sheet === 'Income') &&
        typeof r.confidence === 'number'
    );
    return rules.length ? { rules, source: 'ai' } : fallback();
  } catch {
    return fallback();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/ai-mapper.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/ai-mapper.ts tests/ai-mapper.test.ts package.json package-lock.json
git commit -m "feat: env-gated AI mapping proposal with strict validation and heuristic fallback"
```

---

### Task 12: Survey script (populates template-map anchors from a real template)

**Files:**
- Create: `scripts/survey-template.ts`

- [ ] **Step 1: Implement the script** (no unit test — it is a diagnostic tool; verify by running it)

```ts
/**
 * Survey a real CfR workbook: list all sheet names, and for key sheets dump the
 * (row, CfR code, current value) triples. Use the output to populate ANCHORS in
 * src/template-map.ts for interview-fill targets (losses b/f, TRA totals, etc.).
 *
 * Usage: npm run survey -- "fixtures/returns/<client>/<file>.xlsx" [SheetName ...]
 */
import fs from 'node:fs';
import { listSheetNames, readCfrValues } from '../src/template-reader';

async function main() {
  const [file, ...sheets] = process.argv.slice(2);
  if (!file) {
    console.error('Usage: npm run survey -- <workbook.xlsx> [SheetName ...]');
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const names = await listSheetNames(buf);
  console.log(`Sheets (${names.length}):`);
  for (const n of names) console.log('  ' + n);
  const targets = sheets.length ? sheets : names.filter((n) => /b_sheet|income|tra|^p\d/i.test(n));
  console.log(`\nCode/value rows for: ${targets.join(', ')}`);
  const vals = await readCfrValues(buf, targets);
  for (const v of vals) console.log(`${v.sheet}\trow ${v.row}\tcode ${v.cfrCode}\tvalue ${v.value ?? '—'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Verify against a real fixture if present, else against nothing (skip)**

Run (only if fixtures exist): `npm run survey -- "fixtures/returns/New Way Trading Ltd/TR 971913522 YA2025 (1).xlsx"`
Expected: sheet list including `B_Sheet`, `Income`, `TRA5`-family sheets; code/value dump.
Record discovered anchors (losses b/f row, TRA totals) into `src/template-map.ts` in a follow-up commit when real templates are available.

- [ ] **Step 3: Commit**

```bash
git add scripts/survey-template.ts
git commit -m "feat: template survey script to discover anchors on real CfR workbooks"
```

---

### Task 13: Express server + generation pipeline

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

Endpoints:
- `POST /api/session` — multipart fields `etb` (required), `fs` (optional), `template` (required), `prior` (optional). Parses everything, runs proposal + interview build, returns `{ sessionId, accounts, proposal, interview, warnings, tie, crossCheck }`.
- `POST /api/session/:id/generate` — JSON body `{ rules: MappingRule[], answers: Record<string, number>, clientName, yearOfAssessment }`. Blocks (400) if any ETB account is neither mapped nor in `excludedCodes`; otherwise fills the template, builds the summary, returns `{ downloadReady: true, unmatched }`.
- `GET /api/session/:id/return.xlsx` and `GET /api/session/:id/summary.html` — downloads.
- Static `public/` at `/`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import JSZip from 'jszip';
import { createApp } from '../src/server';
import { syntheticCfrWorkbook, syntheticEtbXlsx } from './helpers/synthetic';

async function fixtures() {
  const etb = syntheticEtbXlsx([
    ['Code', 'Account Name', 'Debit', 'Credit'],
    ['1200', 'Bank current account', 5000, null],
    ['4000', 'Sales', null, 80000],
  ]);
  const template = await syntheticCfrWorkbook({
    bSheet: [{ row: 10, code: 2150 }],
    income: [{ row: 5, code: 5000 }],
  });
  return { etb, template };
}

describe('server', () => {
  it('creates a session from uploads and returns proposal + interview', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const res = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.proposal.rules.length).toBeGreaterThan(0);
    expect(res.body.interview.questions.length).toBeGreaterThan(0);
  });

  it('refuses to generate while accounts are unmapped', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    const res = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({ rules: [], answers: {}, clientName: 'X', yearOfAssessment: 'YA2026', excluded: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unmapped/i);
  });

  it('generates and serves the filled return and summary', async () => {
    const app = createApp();
    const { etb, template } = await fixtures();
    const s = await request(app)
      .post('/api/session')
      .attach('etb', etb, 'etb.xlsx')
      .attach('template', template, 'template.xlsx');
    const gen = await request(app)
      .post(`/api/session/${s.body.sessionId}/generate`)
      .send({
        rules: [
          { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
          { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
        ],
        answers: { depreciationAddBack: 0 },
        clientName: 'Test Client Ltd',
        yearOfAssessment: 'YA2026',
        excluded: [],
      });
    expect(gen.status).toBe(200);
    const xlsx = await request(app).get(`/api/session/${s.body.sessionId}/return.xlsx`);
    expect(xlsx.status).toBe(200);
    const zip = await JSZip.loadAsync(xlsx.body);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<c r="E10"><v>5000</v></c>');
    const summary = await request(app).get(`/api/session/${s.body.sessionId}/summary.html`);
    expect(summary.status).toBe(200);
    expect(summary.text).toContain('Test Client Ltd');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
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
import { readPriorReturn, priorYearCrossCheck } from './prior-return';
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
        if (files?.prior?.[0]) {
          session.priorBuffer = files.prior[0].buffer;
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
      const { rules, answers, clientName, yearOfAssessment, excluded } = req.body as {
        rules: MappingRule[];
        answers: Record<string, number>;
        clientName: string;
        yearOfAssessment: string;
        excluded: string[];
      };
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
          totalAssets: fill.codeCells
            .filter((c) => c.sheet === 'B_Sheet' && c.amount > 0)
            .reduce((a, c) => a + c.amount, 0),
        });

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
        warnings: [...session.warnings, ...(tie && !tie.ok ? tie.issues : [])],
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: express app — session upload, gated generate, downloads"
```

---

### Task 14: 3-step web UI

**Files:**
- Create: `public/index.html` (single file: minimal CSS + vanilla JS)

- [ ] **Step 1: Implement `public/index.html`** — three visible steps; confidence badges on proposals; every proposal editable; unmapped accounts highlighted red; generate button disabled until all mapped/excluded; interview questions rendered with pre-answers, legal basis in small text; downloads at the end. Complete file:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Malta Tax Return Generator</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#15202b}
  h1{font-size:1.5rem} .step{border:1px solid #d0d7de;border-radius:8px;padding:1.25rem;margin:1rem 0}
  .step h2{margin-top:0;font-size:1.1rem} .muted{color:#57606a;font-size:.85rem}
  table{border-collapse:collapse;width:100%;margin:.75rem 0}
  td,th{border:1px solid #d0d7de;padding:5px 8px;font-size:.9rem;text-align:left}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .badge{border-radius:10px;padding:1px 8px;font-size:.75rem;color:#fff}
  .hi{background:#1a7f37}.mid{background:#bf8700}.lo{background:#cf222e}.none{background:#57606a}
  .unmapped{background:#fff1f0}
  button{background:#0969da;color:#fff;border:none;border-radius:6px;padding:.5rem 1.1rem;font-size:.95rem;cursor:pointer}
  button:disabled{background:#8c959f;cursor:not-allowed}
  input[type=number],input[type=text],select{padding:4px 6px;border:1px solid #d0d7de;border-radius:4px}
  .warn{background:#fff7e6;border:1px solid #e6b800;border-radius:6px;padding:.6rem .9rem;margin:.5rem 0;font-size:.9rem}
  .ok{background:#e6ffec;border:1px solid #1a7f37;border-radius:6px;padding:.6rem .9rem;margin:.5rem 0;font-size:.9rem}
  .legal{font-size:.75rem;color:#57606a;font-style:italic}
</style>
</head>
<body>
<h1>Malta Tax Return Generator</h1>
<p class="muted">Upload the ETB, FS and blank CfR template. Confirm the mapping and the tax interview. No figure is ever produced by AI — the official template computes the tax.</p>

<div class="step" id="step1">
  <h2>Step 1 — Upload</h2>
  <form id="uploadForm">
    <p>ETB (Excel, required): <input type="file" name="etb" required accept=".xlsx,.xls"></p>
    <p>Financial statements (Excel, optional): <input type="file" name="fs" accept=".xlsx,.xls"></p>
    <p>Blank CfR return template (required): <input type="file" name="template" required accept=".xlsx,.xlsm"></p>
    <p>Prior-year filed return (optional, improves accuracy): <input type="file" name="prior" accept=".xlsx,.xlsm"></p>
    <p>Client name: <input type="text" id="clientName"> Year of assessment: <input type="text" id="ya" placeholder="YA2026" size="8"></p>
    <button type="submit">Analyse</button>
  </form>
  <div id="uploadMsgs"></div>
</div>

<div class="step" id="step2" hidden>
  <h2>Step 2 — Confirm mapping &amp; tax interview</h2>
  <div id="crossCheck"></div>
  <h3>Account mapping <span class="muted" id="proposalSource"></span></h3>
  <table id="mapTable"><thead><tr><th>Code</th><th>Account</th><th class="num">Balance €</th><th>CfR code</th><th>Sheet</th><th>Confidence</th><th>Exclude</th></tr></thead><tbody></tbody></table>
  <h3>Tax interview</h3>
  <div id="interview"></div>
  <button id="generateBtn" disabled>Generate return</button>
  <div id="genMsgs"></div>
</div>

<div class="step" id="step3" hidden>
  <h2>Step 3 — Download</h2>
  <p><a id="dlReturn" href="#">⬇ Filled tax return (.xlsx)</a> — open in Excel/LibreOffice; the template recalculates the tax on open.</p>
  <p><a id="dlSummary" href="#" target="_blank">⬇ Computation summary (workings)</a></p>
  <div id="finalMsgs"></div>
</div>

<script>
let SESSION = null, ACCOUNTS = [], QUESTIONS = [];

function badge(c){
  if(c==null) return '<span class="badge none">unmapped</span>';
  const cls = c>=.85?'hi':c>=.6?'mid':'lo';
  return `<span class="badge ${cls}">${Math.round(c*100)}%</span>`;
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}

document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch('/api/session', { method:'POST', body: fd });
  const data = await res.json();
  const msgs = document.getElementById('uploadMsgs');
  if(!res.ok){ msgs.innerHTML = `<div class="warn">${esc(data.error)}</div>`; return; }
  SESSION = data.sessionId; ACCOUNTS = data.accounts; QUESTIONS = data.interview.questions;
  msgs.innerHTML = (data.warnings||[]).map(w=>`<div class="warn">${esc(w)}</div>`).join('') ||
    '<div class="ok">Files parsed successfully.</div>';
  document.getElementById('proposalSource').textContent =
    data.proposal.source==='ai' ? '(AI-proposed — confirm each)' : '(heuristic proposal — confirm each)';
  if(data.crossCheck){
    const cc = data.crossCheck;
    document.getElementById('crossCheck').innerHTML = cc.mismatches.length
      ? `<div class="warn">Prior-year cross-check: ${cc.mismatches.length} of ${cc.checkedCodes} codes do not reproduce last year's filed figures — review those mappings. ${cc.mismatches.map(m=>`code ${m.cfrCode}: filed €${m.priorReturnValue} vs mapped €${m.mappedPyValue}`).join('; ')}</div>`
      : `<div class="ok">Prior-year cross-check passed: mapped PY balances reproduce the filed prior return (${cc.checkedCodes} codes).</div>`;
  }
  const byCode = Object.fromEntries(data.proposal.rules.map(r=>[r.ledgerCode,r]));
  const tb = document.querySelector('#mapTable tbody');
  tb.innerHTML = ACCOUNTS.map(a=>{
    const p = byCode[a.accountCode];
    return `<tr data-code="${esc(a.accountCode)}" class="${p?'':'unmapped'}">
      <td>${esc(a.accountCode)}</td><td>${esc(a.accountName)}</td>
      <td class="num">${a.cyBalance.toLocaleString('en-MT',{minimumFractionDigits:2})}</td>
      <td><input type="number" class="cfr" value="${p?p.cfrCode:''}" style="width:90px"></td>
      <td><select class="sheet"><option${p&&p.sheet==='B_Sheet'?' selected':''}>B_Sheet</option><option${p&&p.sheet==='Income'?' selected':''}>Income</option></select></td>
      <td>${badge(p?p.confidence:null)}</td>
      <td><input type="checkbox" class="excl"></td></tr>`;
  }).join('');
  document.getElementById('interview').innerHTML = QUESTIONS.map(q=>`
    <p><label><strong>${esc(q.text)}</strong><br>
    <span class="legal">${esc(q.legalBasis)}</span><br>
    € <input type="number" class="answer" data-id="${esc(q.id)}" value="${q.preAnswer??''}" step="0.01">
    ${q.preAnswer!=null?'<span class="muted">(pre-filled from ETB — confirm)</span>':''}</label></p>`).join('');
  document.getElementById('step2').hidden = false;
  tb.addEventListener('input', refreshGate); tb.addEventListener('change', refreshGate);
  refreshGate();
});

function refreshGate(){
  const rows = [...document.querySelectorAll('#mapTable tbody tr')];
  let allOk = true;
  for(const tr of rows){
    const excl = tr.querySelector('.excl').checked;
    const cfr = tr.querySelector('.cfr').value.trim();
    const ok = excl || cfr !== '';
    tr.classList.toggle('unmapped', !ok);
    if(!ok) allOk = false;
  }
  document.getElementById('generateBtn').disabled = !allOk;
}

document.getElementById('generateBtn').addEventListener('click', async ()=>{
  const rules = [], excluded = [];
  for(const tr of document.querySelectorAll('#mapTable tbody tr')){
    const code = tr.dataset.code;
    if(tr.querySelector('.excl').checked){ excluded.push(code); continue; }
    rules.push({ ledgerCode: code, cfrCode: Number(tr.querySelector('.cfr').value), sheet: tr.querySelector('.sheet').value });
  }
  const answers = {};
  for(const inp of document.querySelectorAll('.answer')) answers[inp.dataset.id] = Number(inp.value||0);
  const res = await fetch(`/api/session/${SESSION}/generate`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ rules, answers, excluded,
      clientName: document.getElementById('clientName').value,
      yearOfAssessment: document.getElementById('ya').value })
  });
  const data = await res.json();
  const msgs = document.getElementById('genMsgs');
  if(!res.ok){ msgs.innerHTML = `<div class="warn">${esc(data.error)}</div>`; return; }
  msgs.innerHTML = data.unmatched.length
    ? `<div class="warn">Codes with no row in this template (NOT written — enter manually): ${data.unmatched.map(u=>`${u.sheet}/${u.cfrCode}`).join(', ')}</div>` : '';
  if(data.tie && !data.tie.ok) msgs.innerHTML += data.tie.issues.map(i=>`<div class="warn">${esc(i)}</div>`).join('');
  document.getElementById('dlReturn').href = `/api/session/${SESSION}/return.xlsx`;
  document.getElementById('dlSummary').href = `/api/session/${SESSION}/summary.html`;
  document.getElementById('step3').hidden = false;
});
</script>
</body>
</html>
```

- [ ] **Step 2: Manual verification via preview**

Add `.claude/launch.json` with `{"version":"0.0.1","configurations":[{"name":"taxgen","runtimeExecutable":"npx","runtimeArgs":["tsx","src/server.ts"],"port":4380}]}`, start the preview, upload synthetic files (generate them with a tiny script or reuse fixtures), walk all 3 steps, confirm the downloaded xlsx opens.

- [ ] **Step 3: Commit**

```bash
git add public/index.html .claude/launch.json
git commit -m "feat: 3-step web UI (upload, confirm, download)"
```

---

### Task 15: Corpus replay harness

Compares generated mapping output against an actually-filed return — no blank template needed: accuracy = % of the filed return's code values our mapped ETB reproduces.

**Files:**
- Create: `scripts/replay.ts`
- Test: `tests/corpus.replay.test.ts` (synthetic always-run + real skipIf)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { replayAccuracy } from '../scripts/replay';
import { syntheticCfrWorkbook } from './helpers/synthetic';
import type { EtbAccount, MappingProfile } from '../src/domain';

describe('replayAccuracy', () => {
  it('scores how many filed code values the mapped ETB reproduces', async () => {
    const filed = await syntheticCfrWorkbook({
      bSheet: [{ row: 10, code: 2150, value: 5000 }],
      income: [{ row: 5, code: 5000, value: -80000 }],
    });
    const etb: EtbAccount[] = [
      { accountCode: '1200', accountName: 'Bank', cyBalance: 5000, pyBalance: null },
      { accountCode: '4000', accountName: 'Sales', cyBalance: -79000, pyBalance: null }, // off by 1000
    ];
    const profile: MappingProfile = {
      rules: [
        { ledgerCode: '1200', cfrCode: 2150, sheet: 'B_Sheet' },
        { ledgerCode: '4000', cfrCode: 5000, sheet: 'Income' },
      ],
    };
    const r = await replayAccuracy(filed, etb, profile);
    expect(r.total).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]).toMatchObject({ cfrCode: 5000, filed: -80000, generated: -79000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/corpus.replay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/replay.ts`**

```ts
/**
 * Corpus replay: how well does the generator reproduce an actually-filed return?
 * Usage: npm run replay -- --etb fixtures/etb/<client>/<year>.xlsx --filed "fixtures/returns/<client>/<file>.xlsx" [--prior "<prior file>"]
 * Accuracy = share of the filed return's non-null code values reproduced within €1
 * by mapping the ETB with the (heuristic/prior-biased) proposal.
 */
import fs from 'node:fs';
import { parseEtb } from '../src/etb-parser';
import { proposeMapping } from '../src/mapping';
import { applyMapping } from '../src/mapping';
import { readPriorReturn } from '../src/prior-return';
import { readCfrValues } from '../src/template-reader';
import type { EtbAccount, MappingProfile } from '../src/domain';

const TOL = 1;

export interface ReplayResult {
  total: number;
  matched: number;
  diffs: Array<{ sheet: string; cfrCode: number; filed: number; generated: number | null }>;
}

export async function replayAccuracy(
  filedReturn: Buffer,
  etb: EtbAccount[],
  profile: MappingProfile
): Promise<ReplayResult> {
  const filed = (await readCfrValues(filedReturn, ['B_Sheet', 'Income'])).filter((v) => v.value !== null);
  const mapped = applyMapping(etb, profile);
  const byKey = new Map(mapped.codeCells.map((c) => [`${c.sheet}:${c.cfrCode}`, c.amount]));
  let matched = 0;
  const diffs: ReplayResult['diffs'] = [];
  for (const f of filed) {
    const gen = byKey.get(`${f.sheet}:${f.cfrCode}`) ?? null;
    if (gen !== null && Math.abs(gen - (f.value as number)) <= TOL) matched++;
    else diffs.push({ sheet: f.sheet, cfrCode: f.cfrCode, filed: f.value as number, generated: gen });
  }
  return { total: filed.length, matched, diffs };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const etbPath = get('etb');
  const filedPath = get('filed');
  if (!etbPath || !filedPath) {
    console.error('Usage: npm run replay -- --etb <etb.xlsx> --filed <filed-return.xlsx> [--prior <prior.xlsx>]');
    process.exit(1);
  }
  const etb = parseEtb(fs.readFileSync(etbPath));
  let priorCodes: Set<number> | undefined;
  const priorPath = get('prior');
  if (priorPath) priorCodes = (await readPriorReturn(fs.readFileSync(priorPath))).codes;
  const proposal = proposeMapping(etb.accounts, { priorYearCodes: priorCodes });
  const r = await replayAccuracy(fs.readFileSync(filedPath), etb.accounts, { rules: proposal.rules });
  console.log(`Replay: ${r.matched}/${r.total} filed code values reproduced (${((100 * r.matched) / Math.max(1, r.total)).toFixed(1)}%)`);
  for (const d of r.diffs)
    console.log(`  MISS ${d.sheet} code ${d.cfrCode}: filed ${d.filed} vs generated ${d.generated ?? '—'}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/corpus.replay.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/replay.ts tests/corpus.replay.test.ts
git commit -m "feat: corpus replay harness scoring generated vs actually-filed returns"
```

---

### Task 16: Full verification + README

- [ ] **Step 1: Run everything**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all suites pass (real-corpus suites skipped without fixtures); tsc exit 0.

- [ ] **Step 2: Write `README.md`** — what it is, golden rule, quickstart (`npm install && npm start` → http://localhost:4380), the 3 steps, fixture policy (sensitive, gitignored, see `scripts/fetch-fixtures.md`), survey + replay usage, v1 limits (current template only, trading companies, anchors grow via survey), and the portal-integration note (core modules `template-writer`/`template-reader`/`mapping`/`interview` are dependency-free for later reuse).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with quickstart, golden rule, replay and survey usage"
```

---

## Post-v1 backlog (not in this plan)

- Populate `ANCHORS` from a survey of the firm's real current-year blank template; wire losses b/f and TRA5 pre-answers from the prior return.
- Full 66-client replay sweep + accuracy report.
- AI-grounding upgrade: few-shot the mapping prompt with corpus example mappings (per-industry).
- Portal integration (reuse core modules; ETB from `EngagementEtb`, output to `EngagementFiling`).
- Multi-tenant product layer (workspaces, sign-off trail, hosted deployment).
- COR correction-form workflow; non-trading entity profiles; multiple template vintages.
```
