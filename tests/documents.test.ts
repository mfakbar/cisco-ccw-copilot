import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractDocument } from '../packages/companion/src/documents.js';

describe('document provenance', () => {
  it('extracts pasted text with a full-text locator', async () => {
    const result = await extractDocument('requirements.txt', 'text/plain', Buffer.from('Minimum 512 GB RAM'));
    expect(result.evidence[0]).toMatchObject({ kind: 'pasted-text', locator: 'full text' });
  });

  it('extracts XLSX cells and sheet ranges without executing workbook content', async () => {
    const workbook = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Compute" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
    const shared = `<?xml version="1.0"?><sst><si><t>Requirement</t></si><si><t>512 GB RAM</t></si></sst>`;
    const sheet = `<?xml version="1.0"?><worksheet><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>`;
    const archive = zipSync({ 'xl/workbook.xml': strToU8(workbook), 'xl/_rels/workbook.xml.rels': strToU8(rels), 'xl/sharedStrings.xml': strToU8(shared), 'xl/worksheets/sheet1.xml': strToU8(sheet) });
    const result = await extractDocument('rfp.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(archive));
    expect(result.text).toContain('Requirement,512 GB RAM');
    expect(result.evidence[0]).toMatchObject({ kind: 'xlsx-range', locator: 'Compute!A1:B1' });
  });
});
