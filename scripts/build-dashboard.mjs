import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/dashboard', { recursive: true });
await Promise.all(['index.html', 'auth.html', 'style.css', 'status.html', 'status.js'].map(name =>
  copyFile(`dashboard/${name}`, `dist/dashboard/${name}`)));
await build({ entryPoints: ['dashboard/app.js', 'dashboard/auth.js'], outdir: 'dist/dashboard',
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022',
  legalComments: 'none' });
