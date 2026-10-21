// Bundles the web service (src/server.ts) into one ES module, with the pack of the catalog models next to it.
//   npm run build:server          -> out/server.mjs and out/<name>-models.pack
//   npm run serve                 -> build, then start it (PORT, default 8080)
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cliName, define, root } from './cli-name.mjs';
import { packModels } from './pack-models.mjs';

const outDir = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(root, 'out');
const packFile = path.join(outDir, `${cliName}-models.pack`);
mkdirSync(outDir, { recursive: true });
if (process.argv.includes('--repack') || !existsSync(packFile)) {
  const { pack, count } = packModels(path.join(root, 'data', 'models'));
  writeFileSync(packFile, pack);
  console.log(`packed ${count} catalog models into ${path.relative(root, packFile)}`);
}
const outfile = path.join(outDir, 'server.mjs');
await build({
  entryPoints: [path.join(root, 'src', 'server.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  logLevel: 'warning',
  loader: { '.html': 'text' },
  define,
});
console.log(`built ${path.relative(root, outfile)}`);
if (process.argv.includes('--run')) process.exitCode = spawnSync(process.execPath, ['--enable-source-maps', outfile], { stdio: 'inherit' }).status ?? 1;
