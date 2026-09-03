import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
const watch = process.argv.includes('--watch');
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['manifest.json', 'sidepanel.html', 'styles.css']) await cp(`src/${file}`, `dist/${file}`);
await cp('src/icons', 'dist/icons', { recursive: true });
const options = { entryPoints: ['src/background.ts', 'src/content.ts', 'src/sidepanel.ts'], bundle: true, format: 'esm', target: 'chrome120', outdir: 'dist', sourcemap: true };
if (watch) { const ctx = await context(options); await ctx.watch(); console.log('Watching extension sources'); }
else await build(options);
