declare module 'pdf-parse' {
  interface PdfResult { text: string; numpages: number; info: Record<string, unknown> }
  export default function parse(buffer: Buffer): Promise<PdfResult>;
}
