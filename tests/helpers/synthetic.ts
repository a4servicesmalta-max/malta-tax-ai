import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

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

/** workbook.xml — unprefixed by default, or `x:`-prefixed element names when p = 'x:'. */
function workbookXml(p: string): string {
  const ns = p ? `xmlns:x="${MAIN_NS}"` : `xmlns="${MAIN_NS}"`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}workbook ${ns} xmlns:r="${REL_NS}">
<${p}sheets>
<${p}sheet name="B_Sheet" sheetId="1" r:id="rId1"/>
<${p}sheet name="Income" sheetId="2" r:id="rId2"/>
<${p}sheet name="p3" sheetId="3" r:id="rId3"/>
</${p}sheets>
</${p}workbook>`;
}

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
</Relationships>`;

/** Sheet with rows: col C = CfR code, col E = existing value (0), col D untouched formula cell. */
function sheetXml(rows: SyntheticRow[], p = ''): string {
  const body = rows
    .map(
      (r) =>
        `<${p}row r="${r.row}"><${p}c r="C${r.row}"${r.codeT ? ` t="${r.codeT}"` : ''}><${p}v>${r.code}</${p}v></${p}c>` +
        `<${p}c r="D${r.row}"><${p}f>${r.formula ?? `SUM(E${r.row})`}</${p}f><${p}v>0</${p}v></${p}c>` +
        (r.value !== undefined
          ? `<${p}c r="E${r.row}"${r.valueT ? ` t="${r.valueT}"` : ''}><${p}v>${r.value}</${p}v></${p}c>`
          : '') +
        `</${p}row>`
    )
    .join('');
  const ns = p ? `xmlns:x="${MAIN_NS}"` : `xmlns="${MAIN_NS}"`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}worksheet ${ns}><${p}sheetData>${body}</${p}sheetData></${p}worksheet>`;
}

export interface SyntheticRow {
  row: number;
  code: number;
  /** Raw text placed in the E cell's <v> — number, or a literal string like '2.5E-5'. */
  value?: number | string;
  /** Optional cell-type attr for the C cell (e.g. 's' = shared string). */
  codeT?: string;
  /** Optional cell-type attr for the E cell (e.g. 's' = shared string). */
  valueT?: string;
  /** Override the D-cell formula (default `SUM(E{row})`). */
  formula?: string;
}

/** Build a minimal CfR-like workbook. p3 gets a bare E6 row for the net-profit direct write. */
export async function syntheticCfrWorkbook(opts: {
  bSheet: SyntheticRow[];
  income: SyntheticRow[];
  /** Emit `x:`-prefixed OOXML element names (some real CfR files serialize this way). */
  prefixed?: boolean;
}): Promise<Buffer> {
  const p = opts.prefixed ? 'x:' : '';
  const ns = p ? `xmlns:x="${MAIN_NS}"` : `xmlns="${MAIN_NS}"`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('xl/workbook.xml', workbookXml(p));
  zip.file('xl/_rels/workbook.xml.rels', WB_RELS);
  zip.file('xl/worksheets/sheet1.xml', sheetXml(opts.bSheet, p));
  zip.file('xl/worksheets/sheet2.xml', sheetXml(opts.income, p));
  zip.file(
    'xl/worksheets/sheet3.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}worksheet ${ns}><${p}sheetData><${p}row r="6"><${p}c r="E6"><${p}v>0</${p}v></${p}c></${p}row></${p}sheetData></${p}worksheet>`
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
