import { spawn, type ChildProcess } from 'node:child_process';

const endpoint = process.env.OLLAMA_HOST?.startsWith('http') ? process.env.OLLAMA_HOST : 'http://127.0.0.1:11434';
let managedProcess: ChildProcess | undefined;

async function isReady(): Promise<boolean> {
  try { return (await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(750) })).ok; }
  catch { return false; }
}

export async function listOllamaModels(): Promise<string[]> {
  const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Ollama model discovery failed: ${response.status}`);
  const data = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  return [...new Set((data.models ?? []).flatMap((item) => item.model ?? item.name ?? []))].sort((a, b) => a.localeCompare(b));
}

export async function ensureOllama(): Promise<'already-running' | 'started' | 'unavailable'> {
  if (await isReady()) return 'already-running';
  try {
    managedProcess = spawn(process.env.OLLAMA_BIN ?? 'ollama', ['serve'], { stdio: 'ignore' });
    managedProcess.once('error', (error) => console.warn(`Could not start Ollama: ${error.message}`));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await isReady()) return 'started';
      if (managedProcess.exitCode !== null) break;
    }
  } catch (error) { console.warn(`Could not start Ollama: ${error instanceof Error ? error.message : String(error)}`); }
  return 'unavailable';
}

export function stopManagedOllama(): void {
  if (managedProcess?.exitCode === null) managedProcess.kill('SIGTERM');
}
