import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RequirementSet } from '@ccw/shared';

const root = join(homedir(), 'Library', 'Application Support', 'CCW-BoQ-Copilot', 'projects');
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid project id'); return id; };
export async function saveProject(project: RequirementSet) { await mkdir(root, { recursive: true }); await writeFile(join(root, `${safeId(project.id)}.json`), JSON.stringify(project, null, 2), { mode: 0o600 }); }
export async function loadProject(id: string): Promise<RequirementSet> { return JSON.parse(await readFile(join(root, `${safeId(id)}.json`), 'utf8')) as RequirementSet; }
