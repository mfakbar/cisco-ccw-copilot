import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { extractDocument } from './documents.js';
import { extractRequirements, type ProviderConfig } from './providers.js';
import { loadProject, saveProject } from './store.js';
import { ensureOllama, listOllamaModels, stopManagedOllama } from './ollama.js';

const port = Number(process.env.CCW_COPILOT_PORT ?? 3219);
const sessionToken = process.env.CCW_COPILOT_TOKEN ?? randomBytes(24).toString('hex');
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
const body = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as any; };

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/health') return json(res, 200, { ok: true, version: '0.1.8' });
    if (req.headers.authorization !== `Bearer ${sessionToken}`) return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }); return res.end(); }
    if (req.method === 'POST' && req.url === '/documents/extract') {
      const input = await body(req); return json(res, 200, await extractDocument(input.name, input.mimeType, Buffer.from(input.base64, 'base64')));
    }
    if (req.method === 'POST' && req.url === '/requirements/extract') {
      const input = await body(req); const config = input.config as ProviderConfig;
      return json(res, 200, await extractRequirements(config, input.text));
    }
    if (req.method === 'GET' && req.url === '/ollama/models') return json(res, 200, { models: await listOllamaModels() });
    if (req.method === 'POST' && req.url === '/projects') { const input = await body(req); await saveProject(input); return json(res, 204, {}); }
    if (req.method === 'GET' && req.url?.startsWith('/projects/')) return json(res, 200, await loadProject(decodeURIComponent(req.url.slice(10))));
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
});

const ollamaStatus = await ensureOllama();
server.listen(port, '127.0.0.1', () => console.log(`CCW companion listening on http://127.0.0.1:${port}\nSession token: ${sessionToken}\nOllama: ${ollamaStatus}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopManagedOllama(); server.close(() => process.exit(0)); });
