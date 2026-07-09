/**
 * Malta company income tax return filing deadlines — statutory rule plus the
 * YA2025/YA2026 e-filing extension tables (verified against official MTCA
 * notices, July 2026). Pure lookup, no I/O, no Date.now().
 *
 * ponytail: only YA2025/YA2026 extension tables are held; other years fall
 * back to a pointer at mtca.gov.mt rather than guessing dates.
 */

interface DeadlineRow {
  /** JS Date#getMonth() values (0=Jan) that fall in this FY-end bucket. */
  months: number[];
  fyEndLabel: string;
  manual: string;
  electronic: string;
}

const STATUTORY_RULE =
  'Statutory rule: the return is due 9 months after the financial year end ' +
  '(FY ends 1 Jan–30 Jun are due 31 March of the following year).';

const PAYMENT_RULE =
  'Payment: tax must be settled by the statutory return date above — the ' +
  'electronic filing extension does NOT extend the payment deadline; late ' +
  'payment bears interest at 0.6% per month or part thereof (not remittable).';

const LATE_FILING_SCALE =
  'Late filing: additional tax of €50 where the return is filed within 6 ' +
  'months of the due date, rising on the Cap. 123 Schedule Table B scale ' +
  '(up to €1,500) for later filing.';

const TABLES: Record<'2025' | '2026', DeadlineRow[]> = {
  '2026': [
    { months: [0, 1, 2, 3, 4, 5], fyEndLabel: 'Jan–Jun 2025', manual: '31 March 2026', electronic: '31 July 2026' },
    { months: [6], fyEndLabel: '31 July 2025', manual: '30 April 2026', electronic: '31 July 2026' },
    { months: [7], fyEndLabel: '31 August 2025', manual: '31 May 2026', electronic: '31 July 2026' },
    { months: [8], fyEndLabel: '30 September 2025', manual: '30 June 2026', electronic: '31 August 2026' },
    { months: [9], fyEndLabel: '31 October 2025', manual: '31 July 2026', electronic: '30 September 2026' },
    { months: [10], fyEndLabel: '30 November 2025', manual: '31 August 2026', electronic: '30 October 2026' },
    { months: [11], fyEndLabel: '31 December 2025', manual: '30 September 2026', electronic: '27 November 2026' },
  ],
  '2025': [
    { months: [0, 1, 2, 3, 4, 5], fyEndLabel: 'Jan–Jun 2024', manual: '31 March 2025', electronic: '31 July 2025' },
    { months: [6], fyEndLabel: '31 July 2024', manual: '30 April 2025', electronic: '31 July 2025' },
    { months: [7], fyEndLabel: '31 August 2024', manual: '31 May 2025', electronic: '31 July 2025' },
    { months: [8], fyEndLabel: '30 September 2024', manual: '30 June 2025', electronic: '29 August 2025' },
    { months: [9], fyEndLabel: '31 October 2024', manual: '31 July 2025', electronic: '30 September 2025' },
    { months: [10], fyEndLabel: '30 November 2024', manual: '31 August 2025', electronic: '31 October 2025' },
    { months: [11], fyEndLabel: '31 December 2024', manual: '30 September 2025', electronic: '28 November 2025' },
  ],
};

const rowLine = (yearOfAssessment: string, r: DeadlineRow, illustrative: boolean): string =>
  `FY end ${r.fyEndLabel} (YA${yearOfAssessment}${illustrative ? ', illustrative — most common year-end' : ''}): ` +
  `manual filing deadline ${r.manual}; electronic filing deadline ${r.electronic}.`;

/** Extracts "2025"/"2026" from "2026", "YA2026" or "YA 2026"; null if not one of those years. */
function normalizeYa(yearOfAssessment: string): '2025' | '2026' | null {
  const m = yearOfAssessment.match(/(\d{4})/);
  const year = m?.[1];
  return year === '2025' || year === '2026' ? year : null;
}

/**
 * Plain-English filing-deadline note lines for the computation summary.
 * `fyEnd`, when given, picks the matching row from the extension table;
 * otherwise the 31 December row is shown as the illustrative default.
 */
export function filingDeadlineLines(yearOfAssessment: string, fyEnd?: Date | null): string[] {
  const ya = normalizeYa(yearOfAssessment);
  if (!ya) {
    return [
      STATUTORY_RULE,
      PAYMENT_RULE,
      `The YA${yearOfAssessment} e-filing extension table has not been verified in this module — ` +
        `check mtca.gov.mt for the applicable manual/electronic deadlines (data verified July 2026).`,
    ];
  }

  const table = TABLES[ya];
  const matched = fyEnd ? table.find((r) => r.months.includes(fyEnd.getMonth())) : null;
  const lines = [STATUTORY_RULE];

  if (matched) {
    lines.push(rowLine(ya, matched, false));
  } else {
    const dec = table[table.length - 1];
    lines.push(rowLine(ya, dec, true));
    lines.push(`Other year-ends: check the MTCA YA${ya} e-filing extension table for the applicable manual/electronic deadlines.`);
  }

  lines.push(PAYMENT_RULE, LATE_FILING_SCALE);
  return lines;
}
