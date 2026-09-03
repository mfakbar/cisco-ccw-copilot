import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const service = 'CCW-BoQ-Copilot';

export async function saveSecret(account: string, secret: string): Promise<void> {
  await exec('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', secret]);
}
export async function readSecret(account: string): Promise<string | undefined> {
  try { return (await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'])).stdout.trim(); }
  catch { return undefined; }
}
