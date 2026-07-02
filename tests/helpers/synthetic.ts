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
