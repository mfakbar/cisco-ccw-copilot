import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { SourceEvidence } from '@ccw/shared';

export interface ExtractedDocument { name: string; text: string; evidence: SourceEvidence[] }

const compact = (value: string) => value.replace(/\s+/g, ' ').trim();

export async function extractDocument(name: string, mimeType: string, buffer: Buffer): Promise<ExtractedDocument> {
  if (mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
    const parsed = await pdf(buffer);
    const pages: string[] = parsed.text.split(/\f|\n\s*\n(?=\s*Page\s+\d+)/i).filter(Boolean);
    return { name, text: parsed.text, evidence: pages.map((page, index) => ({ documentName: name, kind: 'pdf-page', locator: `page ${index + 1}`, excerpt: compact(page).slice(0, 500) })) };
  }
  if (name.toLowerCase().endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    const sections = result.value.split(/\n{2,}/).filter(Boolean);
    return { name, text: result.value, evidence: sections.map((section, index) => ({ documentName: name, kind: 'docx-heading', locator: `paragraph ${index + 1}`, excerpt: compact(section).slice(0, 500) })) };
  }
  if (/\.xlsx?$/i.test(name)) {
    if (name.toLowerCase().endsWith('.xls')) throw new Error('Legacy .xls is not supported safely. Save it as .xlsx and retry.');
    const archive = unzipSync(new Uint8Array(buffer));
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
    const parseEntry = (path: string) => { const entry = archive[path]; if (!entry) throw new Error(`Invalid XLSX: missing ${path}`); return parser.parse(strFromU8(entry)) as any; };
    const sharedRaw = archive['xl/sharedStrings.xml'] ? parseEntry('xl/sharedStrings.xml').sst?.si : [];
    const shared = (Array.isArray(sharedRaw) ? sharedRaw : sharedRaw ? [sharedRaw] : []).map((item: any) => typeof item.t === 'object' ? String(item.t['#text'] ?? '') : item.t !== undefined ? String(item.t) : (Array.isArray(item.r) ? item.r : [item.r]).filter(Boolean).map((run: any) => typeof run.t === 'object' ? run.t['#text'] : run.t).join(''));
    const workbook = parseEntry('xl/workbook.xml');
    const rels = parseEntry('xl/_rels/workbook.xml.rels');
    const relationships = (Array.isArray(rels.Relationships?.Relationship) ? rels.Relationships.Relationship : [rels.Relationships?.Relationship]).filter(Boolean);
    const targetById = new Map(relationships.map((r: any) => [r['@_Id'], String(r['@_Target'])]));
    const sheetsRaw = workbook.workbook?.sheets?.sheet;
    const sheets = (Array.isArray(sheetsRaw) ? sheetsRaw : [sheetsRaw]).filter(Boolean);
    const evidence: SourceEvidence[] = [];
    const text: string[] = [];
    for (const sheet of sheets) {
      const target = targetById.get(sheet['@_r:id']) as string | undefined;
      if (!target) continue;
      const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      const xml = parseEntry(normalized);
      const rowsRaw = xml.worksheet?.sheetData?.row;
      const rows = (Array.isArray(rowsRaw) ? rowsRaw : rowsRaw ? [rowsRaw] : []).map((row: any) => {
        const cells = (Array.isArray(row.c) ? row.c : row.c ? [row.c] : []);
        return cells.map((cell: any) => { const raw = typeof cell.v === 'object' ? cell.v['#text'] : cell.v; return cell['@_t'] === 's' ? shared[Number(raw)] ?? '' : cell['@_t'] === 'inlineStr' ? cell.is?.t ?? '' : raw ?? ''; }).join(',');
      });
      const csv = rows.join('\n');
      const sheetName = String(sheet['@_name'] ?? 'Sheet');
      const range = String(xml.worksheet?.dimension?.['@_ref'] ?? 'A1');
      text.push(`[Sheet: ${sheetName}]\n${csv}`);
      evidence.push({ documentName: name, kind: 'xlsx-range', locator: `${sheetName}!${range}`, excerpt: compact(csv).slice(0, 500) });
    }
    return { name, text: text.join('\n\n'), evidence };
  }
  const text = buffer.toString('utf8');
  return { name, text, evidence: [{ documentName: name, kind: 'pasted-text', locator: 'full text', excerpt: compact(text).slice(0, 500) }] };
}
