/**
 * Printable computation summary: accounting profit -> adjustments -> chargeable
 * income inputs, with provenance for every line. Pure function of confirmed
 * data; the CfR template remains the authoritative tax computation.
 */
import type { InterviewFill } from './domain';
import type { TaxComputation } from './tax-computation';
import { filingDeadlineLines } from './filing-deadlines';

export interface SummaryInput {
  clientName: string;
  yearOfAssessment: string;
  netProfitPerAccounts: number;
  /** The deterministic working paper the preparer reviewed before generating. */
  computation: TaxComputation;
  fills: InterviewFill[];
  mappingRows: Array<{ ledger: string; cfrCode: number; sheet: string; amount: number }>;
  warnings: string[];
  unmatchedCodes: Array<{ sheet: string; cfrCode: number }>;
}

const eur = (n: number) =>
  n.toLocaleString('en-MT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The working-paper table: profit → adjustments → CA → loss relief → chargeable income → tax @35%. */
export function renderComputationTable(c: TaxComputation): string {
  const row = (label: string, amount: number, cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(label)}</td><td class="num">${eur(amount)}</td></tr>`;
  const rows = [
    row('Net profit/(loss) before tax per financial statements', c.netProfitPerAccounts),
    ...c.addBacks.map((l) => row(l.label, l.amount)),
    ...(c.addBacks.length ? [row('Total add-backs', c.totalAddBacks, 'sub')] : []),
    ...c.deductions.map((l) => row(`Less: ${l.label}`, -l.amount)),
    row('Adjusted profit/(loss) before capital allowances', c.adjustedProfit, 'sub'),
    ...(c.capitalAllowances ? [row('Less: capital allowances', -c.capitalAllowances)] : []),
    ...(c.capitalAllowances ? [row('Income/(loss) after capital allowances', c.incomeAfterCapitalAllowances, 'sub')] : []),
    ...(c.lossesBroughtForward
      ? [
          row('Losses brought forward (memo)', c.lossesBroughtForward),
          row('Less: losses utilised this year', -c.lossesUtilised),
          row('Losses carried forward (memo)', c.lossesCarriedForward),
        ]
      : []),
    row('Chargeable income', c.chargeableIncome, 'sub'),
    row('Tax charge @ 35% (Cap. 123 Art. 56(6))', c.taxCharge, 'total'),
  ].join('\n');
  const notes = c.notes.map((n) => `<li>${esc(n)}</li>`).join('\n');
  return `<table class="comp"><tr><th>Item</th><th>Amount €</th></tr>${rows}</table>${
    notes ? `<ul class="notes">${notes}</ul>` : ''
  }`;
}

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
        `<tr><td>${esc(m.ledger)}</td><td>${esc(m.sheet)}</td><td>${m.cfrCode}</td><td class="num">${eur(m.amount)}</td></tr>`
    )
    .join('\n');
  const warn = [...input.warnings, ...input.unmatchedCodes.map((u) => `Unmatched CfR code ${u.cfrCode} on ${u.sheet} — not written.`)]
    .map((w) => `<li>${esc(w)}</li>`)
    .join('\n');
  const deadlines = filingDeadlineLines(input.yearOfAssessment)
    .map((d) => `<li>${esc(d)}</li>`)
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Tax computation — ${esc(input.clientName)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:2rem;color:#111}
table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
.num{text-align:right;font-variant-numeric:tabular-nums}h2{margin-top:2rem}
.warn{background:#fff7e6;border:1px solid #e6b800;padding:1rem}
.comp tr.sub td{border-top:2px solid #888;font-weight:600}
.comp tr.total td{border-top:3px double #111;font-weight:700}
.notes{font-size:.9rem;color:#57606a}</style></head><body>
<h1>Income tax computation workings — ${esc(input.clientName)} (${esc(input.yearOfAssessment)})</h1>
<p>Prepared by the Malta Tax Return Generator. Figures are deterministic (ETB + confirmed answers);
the CfR return template computes the tax. This document shows the workings and provenance.</p>
<h2>Tax computation</h2>
${renderComputationTable(input.computation)}
${deadlines ? `<h2>Filing deadlines (Year of Assessment ${esc(input.yearOfAssessment)})</h2><ul>${deadlines}</ul>` : ''}
<h2>Tax adjustments (confirmed in interview)</h2>
<table><tr><th>Adjustment</th><th>Amount €</th><th>Treatment</th></tr>${adj || '<tr><td colspan="3">None</td></tr>'}</table>
<h2>Account mapping (provenance)</h2>
<table><tr><th>Ledger account</th><th>Sheet</th><th>CfR code</th><th>Amount €</th></tr>${map}</table>
${warn ? `<h2>Warnings</h2><div class="warn"><ul>${warn}</ul></div>` : ''}
</body></html>`;
}
