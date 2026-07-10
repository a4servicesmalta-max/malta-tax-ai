/**
 * Template vintage detection, stored verified-blank templates, and the firm's
 * standing declaration fills.
 *
 * WHY: preparers reuse a prior filed return (any client's) as the "template"
 * upload. v1 cleared stale figures on account code rows only — everything else
 * (name/TIN, attachment-complete flags, p2 questionnaire, TRA schedules)
 * survived from the donor client or arrived blank where the CfR e-return
 * requires an answer. Fix in two parts:
 *
 *  1. SWAP-TO-BLANK — data/blank-templates/ ships verified, scrubbed blank
 *     copies of each supported CfR vintage (produced by scripts/blank-return.mts,
 *     PII-scanned). When an uploaded template's vintage matches a stored blank,
 *     the blank is used instead of the upload, killing every stale-residue bug
 *     at once.
 *
 *  2. DECLARATION FILLS — the survey of 6 real filed returns (2 vintages,
 *     6 clients, 2026-07-10) found an identical ~30-cell battery the firm
 *     answers the same way on every return (attachment-complete flags, p2
 *     Y/N questionnaire, refund-by-cheque "No", ATAD TRA111 answers). These
 *     are written deterministically — never AI — and each write is listed for
 *     the preparer's review. Only refs the template itself declares mandatory
 *     (its own IF(<ref>="",re,…) "Required!" markers) are written, so vintage
 *     drift (e.g. p5!H48 vs H52) self-resolves.
 */
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import type { CfrDirectCell } from './template-writer';

// Repo-tracked static assets (NOT the gitignored runtime data/ dir — these
// must ship with every deploy). PII-scrubbed and leak-scanned before commit.
const BLANKS_DIR = path.join(process.cwd(), 'blank-templates');

/** Cached "TA2_e-CO_2024_Ver 1.2"-style version string, from any sheet. */
export async function detectTemplateVersion(buffer: Buffer): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
    for (const n of names.slice(0, 6)) {
      const xml = await zip.file(n)!.async('string');
      const m = xml.match(/TA2_e-CO_\d{4}_Ver [\d.]+/);
      if (m) return m[0];
    }
  } catch {
    /* not a workbook — caller surfaces its own error */
  }
  return null;
}

/** Verified blank for this vintage, or null when we don't ship one. */
export function loadStoredBlank(version: string): Buffer | null {
  const file = path.join(BLANKS_DIR, version.replace(/[^A-Za-z0-9.-]+/g, '_') + '.xlsx');
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Refs each sheet's own IF(<ref>="",re,…) markers declare mandatory. */
export async function requiredCellRefs(buffer: Buffer): Promise<{ required: Set<string>; sheets: Set<string> }> {
  const zip = await JSZip.loadAsync(buffer);
  const wbXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const relTarget: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]*)"/)?.[1];
    const t = m[0].match(/\bTarget="([^"]*)"/)?.[1];
    if (id && t) relTarget[id] = t;
  }
  const required = new Set<string>();
  const sheets = new Set<string>();
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = m[0].match(/\bname="([^"]*)"/)?.[1];
    const rid = m[0].match(/\br:id="([^"]*)"/)?.[1];
    if (!name || !rid || !relTarget[rid]) continue;
    sheets.add(name);
    const p = 'xl/' + relTarget[rid].replace(/^\//, '').replace(/^xl\//, '');
    const file = zip.file(p);
    if (!file) continue;
    const xml = await file.async('string');
    for (const fm of xml.matchAll(/<f[^>]*>([^<]*)<\/f>/g))
      for (const rm of fm[1].matchAll(/IF\(\s*\$?([A-Z]{1,2})\$?(\d+)\s*=\s*(?:""|&quot;&quot;)\s*,\s*re\s*[,)]/g))
        required.add(`${name}!${rm[1]}${rm[2]}`);
  }
  return { required, sheets };
}

/** One standing declaration: where it goes and what the preparer is told. */
interface Declaration {
  sheet: string;
  ref: string;
  value: number | string;
  note: string;
}

// Identical across all 6 surveyed filed returns (both vintages). Anything
// client-specific (audit qualified?, employees, ATAD standalone) comes from
// the interview instead — see declarationCells().
// ponytail: auditor name is this deployment's firm; make it an env/setting
// when a second firm signs up.
const STANDING: Declaration[] = [
  { sheet: 'TRA9_14', ref: 'C153', value: 'Yes', note: 'TRA9-14 attachment marked complete' },
  { sheet: 'TRA29', ref: 'C112', value: 'Yes', note: 'TRA29 attachment marked complete' },
  { sheet: 'TRA31', ref: 'E166', value: 'Yes', note: 'TRA31 (tax payments) attachment marked complete' },
  { sheet: 'TRA62_IPA', ref: 'E86', value: 'Yes', note: 'TRA62 (IPA) attachment marked complete' },
  { sheet: 'TRA62_IPA', ref: 'G5', value: 'No', note: 'TRA62: no immovable-property transfers outside scope' },
  { sheet: 'TRA62A_IPA', ref: 'C90', value: 'Yes', note: 'TRA62A (IPA) attachment marked complete' },
  { sheet: 'TRA63_MTA_FIA', ref: 'O57', value: 'Yes', note: 'TRA63 (MTA/FIA) attachment marked complete' },
  { sheet: 'TRA111', ref: 'I93', value: 'Yes', note: 'TRA111 attachment marked complete' },
  { sheet: 'TRA66', ref: 'AB3', value: 1, note: 'TRA66 selector default' },
  { sheet: 'TRA80', ref: 'T25', value: 0, note: 'TRA80 default 0' },
  { sheet: 'TRA80', ref: 'H27', value: 0, note: 'TRA80 default 0' },
  { sheet: 'TRA103', ref: 'C15', value: 0, note: 'TRA103 tax credit approved: 0' },
  { sheet: 'p2', ref: 'G58', value: 'Malta', note: 'p2: country of residence — Malta' },
  { sheet: 'p2', ref: 'C75', value: 'A4 Services Limited', note: 'p2: auditor — A4 Services Limited' },
  { sheet: 'p5', ref: 'H48', value: 'No', note: 'p5: refund by direct credit — No' },
  { sheet: 'p5', ref: 'H52', value: 'No', note: 'p5: refund by direct credit — No' },
  ...['G7', 'G20', 'G29', 'G30', 'G31', 'G32', 'G33', 'G35', 'G36', 'G38', 'G39', 'G40', 'G41', 'G54', 'G91', 'G92', 'G93', 'G94'].map(
    (ref) => ({ sheet: 'p2', ref, value: 'N', note: `p2!${ref}: questionnaire — N` })
  ),
  ...['G71', 'G72', 'G73', 'G85'].map((ref) => ({
    sheet: 'p2',
    ref,
    value: 'Y',
    note: `p2!${ref}: accounts/audit signed — Y`,
  })),
];

export interface DeclarationInput {
  /** From requiredCellRefs() on the ACTUAL template being filled. */
  required: Set<string>;
  sheets: Set<string>;
  /** Company identity typed by the preparer (or lifted from the prior return). */
  companyName?: string;
  companyTin?: string;
  /** Deterministic interest-expense total from the mapped ETB (ATAD TRA111 EBC). */
  interestExpense: number;
  /** Interview answers (numeric protocol: Y/N answers are 1/0). */
  answers: Record<string, number>;
}

export function declarationCells(input: DeclarationInput): { cells: CfrDirectCell[]; notes: string[] } {
  const cells: CfrDirectCell[] = [];
  const notes: string[] = [];
  const add = (sheet: string, ref: string, value: number | string, note: string, always = false) => {
    if (!input.sheets.has(sheet)) return;
    if (!always && !input.required.has(`${sheet}!${ref}`)) return;
    cells.push({ sheet, ref, value });
    notes.push(note);
  };

  // Company identity — every sheet header (`Ref: … Name: …`) derives from
  // these two master cells via the reg/NM defined names.
  if (input.companyTin) {
    const tin = input.companyTin.trim();
    add('p1', 'AG8', /^\d+$/.test(tin) ? Number(tin) : tin, `p1: taxpayer reference ${tin}`, true);
  }
  if (input.companyName) {
    add('p1', 'L10', input.companyName.trim().toUpperCase(), `p1: company name ${input.companyName.trim().toUpperCase()}`, true);
  }

  for (const d of STANDING) add(d.sheet, d.ref, d.value, d.note);

  // Interview-driven p2 answers (required on every filing, client-specific).
  const qualified = (input.answers['auditReportQualified'] ?? 0) === 1;
  add('p2', 'F76', qualified ? 'Yes' : 'No', `p2: audit report qualified/EoM — ${qualified ? 'Yes' : 'No'}`);
  if (qualified)
    notes.push('Audit report marked qualified/emphasis-of-matter — type the description into p2 cell C78 before submitting.');
  const standalone = (input.answers['atadStandaloneEntity'] ?? 0) === 1;
  add('p2', 'G34', standalone ? 'Y' : 'N', `p2: ATAD standalone/financial-undertaking entity — ${standalone ? 'Y' : 'N'}`);
  const employees = Math.max(0, Math.round(input.answers['avgEmployees'] ?? 0));
  add('p2', 'G60', employees, `p2: average number of employees — ${employees}`);
  if (employees > 0) add('p2', 'G62', 'Yes', 'p2: wages/salaries reported on FS3/FS7 — Yes');

  // ATAD interest-limitation (TRA111): the firm's standing answers, with the
  // exceeding-borrowing-costs amount taken deterministically from the ETB.
  if (input.sheets.has('TRA111')) {
    const ebc = Math.round(Math.max(0, input.interestExpense));
    if (ebc < 3_000_000) {
      cells.push(
        { sheet: 'TRA111', ref: 'K6', value: 'No' },
        { sheet: 'TRA111', ref: 'K11', value: 'Yes' },
        { sheet: 'TRA111', ref: 'N11', value: ebc }
      );
      notes.push(
        `TRA111 (ATAD interest limitation): no Reg 4(4) loans; EBC €${ebc.toLocaleString('en-MT')} ≤ €3M — opted out of the full computation`
      );
    } else {
      notes.push(
        `TRA111: exceeding borrowing costs €${ebc.toLocaleString('en-MT')} exceed the €3,000,000 de-minimis — complete the interest-limitation computation on TRA111 manually.`
      );
    }
  }

  return { cells, notes };
}

/**
 * Company identity as typed on a filed return: TIN at p1!AG8, name at p1!L10.
 * Used to pre-fill the new return's identity from the client's prior return.
 */
export async function readCompanyIdentity(buffer: Buffer): Promise<{ tin: string | null; name: string | null }> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const wbXml = await zip.file('xl/workbook.xml')!.async('string');
    const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
    const rid = wbXml.match(/<sheet name="p1"[^>]*r:id="(rId\d+)"/)?.[1];
    const target = rid && relsXml.match(new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1];
    if (!target) return { tin: null, name: null };
    const xml = await zip.file('xl/' + target.replace(/^\//, '').replace(/^xl\//, ''))!.async('string');
    const cell = (ref: string) =>
      xml.match(new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`)) as RegExpMatchArray | null;
    const tinM = cell('AG8');
    const tin = tinM?.[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1]?.trim() || null;
    const nameM = cell('L10');
    let name: string | null = null;
    if (nameM?.[2]) {
      const v = nameM[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? nameM[2].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      if (v !== undefined) {
        if (/\bt="s"/.test(nameM[1])) {
          const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
          const sst = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
            [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')
          );
          name = sst[parseInt(v, 10)] ?? null;
        } else {
          name = v;
        }
      }
    }
    return { tin, name: name?.trim() || null };
  } catch {
    return { tin: null, name: null };
  }
}

/**
 * Deterministic interest-expense total (Dr) from the included ETB accounts —
 * feeds TRA111's EBC amount. Name-matched, never model-derived.
 */
export function interestExpenseTotal(
  accounts: Array<{ accountName: string; cyBalance: number; statement?: 'PL' | 'BS' | null }>
): number {
  let total = 0;
  for (const a of accounts) {
    if (a.statement === 'BS') continue;
    if (!/interest|finance\s*(cost|charge)/i.test(a.accountName)) continue;
    if (/receiv|income|earned/i.test(a.accountName)) continue;
    if (a.cyBalance > 0) total += a.cyBalance;
  }
  return total;
}
