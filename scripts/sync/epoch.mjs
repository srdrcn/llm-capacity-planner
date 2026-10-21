// Cross-checks the GPU catalog (data/hardware.json) with Epoch AI's ML hardware dataset, updated daily upstream.
//
//   npm run sync:epoch                         read https://epoch.ai/data/ml_hardware.csv, print the report
//   npm run sync:epoch -- --file x.csv         read a local copy instead (air-gapped: download it elsewhere)
//   npm run sync:epoch -- --write              also write drafts of new cards to data/pending-gpus.json
//   npm run sync:epoch -- --report out.md      also write the report as Markdown (issue / PR body)
//
// Exit code: 0 nothing to look at, 1 new cards / differing values / renamed rows, 2 the export could not be read.
// HTTPS_PROXY is honoured (Node's fetch with NODE_USE_ENV_PROXY=1, set by re-running as main.ts does).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, missingColumns, needsAttention, parseCsv, reportMarkdown } from './epoch-lib.mjs';

const env = process.env;
if ((env.HTTPS_PROXY || env.https_proxy) && env.NODE_USE_ENV_PROXY !== '1') {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const URL_DEFAULT = env.EPOCH_CSV_URL || 'https://epoch.ai/data/ml_hardware.csv';
const file = opt('--file');
const source = file ?? URL_DEFAULT;

let text;
try {
  if (file) text = readFileSync(file, 'utf8');
  else {
    const res = await fetch(URL_DEFAULT, { headers: { 'user-agent': 'llm-capacity-planner catalog sync' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  }
} catch (e) {
  console.error(`Cannot read ${source}: ${e.message}`);
  process.exit(2);
}

const rows = parseCsv(text);
const missing = missingColumns(rows);
if (missing.length) {
  console.error(`The Epoch export changed shape: missing column(s) ${missing.join(', ')}. Update COL in scripts/sync/epoch-lib.mjs.`);
  process.exit(2);
}
const hardware = JSON.parse(readFileSync(path.join(root, 'data', 'hardware.json'), 'utf8'));
const map = JSON.parse(readFileSync(path.join(root, 'data', 'epoch-map.json'), 'utf8'));
const result = compare(rows, hardware, map);
const report = reportMarkdown(result, { source, checkedOn: new Date().toISOString().slice(0, 10) });
console.log(report);

if (args.includes('--write')) {
  const pendingFile = path.join(root, 'data', 'pending-gpus.json');
  let pending = { $comment: '', gpus: [] };
  try {
    pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
  } catch {}
  // Drafts already there keep their edits; new cards are appended.
  const have = new Set(pending.gpus.map((g) => g.name));
  const fresh = result.added.filter((a) => !have.has(a.name));
  pending = {
    $comment: 'Drafts of NVIDIA cards Epoch AI lists and hardware.json does not (scripts/sync/epoch.mjs). Not used by the planner: complete each from the NVIDIA datasheet, move it to hardware.json, or add its Epoch name to epoch-map.json "ignore".',
    gpus: [...pending.gpus, ...fresh],
  };
  writeFileSync(pendingFile, JSON.stringify(pending, null, 2) + '\n');
  console.error(`${fresh.length} new draft(s) written to data/pending-gpus.json`);
}
const reportFile = opt('--report');
if (reportFile) writeFileSync(reportFile, report);
process.exitCode = needsAttention(result) ? 1 : 0;
