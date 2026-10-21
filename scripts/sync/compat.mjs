// Keeps the vLLM / SGLang compatibility matrix (data/compat.json) on the latest engine releases, unattended.
//
//   npm run sync:compat                    find the latest stable tags; when newer than the matrix, re-check every
//                                          cited line of engine code at the new tags (dev/update-compat.mjs --anchors
//                                          --rebase) and the model registries (--registry)
//   npm run sync:compat -- --report f.md   also write the report as Markdown (pull-request body)
//   npm run sync:compat -- --vllm v0.32.0 --sglang v0.5.22   check given tags instead of the latest
//
// When every cited line is still found at the new tags, the sources are moved to them and "engines" (version, ref,
// commit) is updated: the matrix then states the new releases. When a line vanished or moved ambiguously, the sources
// that were found are moved, "engines" is left as it is and the report lists what a person must verify.
// Exit code: 0 already on the latest releases, 1 something changed (open a pull request), 2 error.
// Tags come from `git ls-remote` (no API token needed); files from raw.githubusercontent.com.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const compatFile = path.join(root, 'data', 'compat.json');
const updater = path.join(root, 'scripts', 'dev', 'update-compat.mjs');
const REPOS = { vllm: 'vllm-project/vllm', sglang: 'sgl-project/sglang' };
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Stable release tags (vX.Y.Z) of a repo, newest last, with the commit each points to. */
export function stableTags(lsRemote) {
  const tags = new Map();
  for (const line of lsRemote.split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(line.trim());
    // An annotated tag is listed twice: the tag object, then (^{}) the commit it points to.
    if (m && (m[3] || !tags.has(m[2]))) tags.set(m[2], m[1]);
  }
  const v = (t) => t.slice(1).split('.').map(Number);
  return [...tags].map(([tag, commit]) => ({ tag, commit })).sort((a, b) => {
    const [x, y] = [v(a.tag), v(b.tag)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

function latest(engine) {
  const out = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${REPOS[engine]}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stableTags(out);
}

function run(flags) {
  const r = spawnSync(process.execPath, [updater, ...flags], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 2, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function main() {
  const compat = JSON.parse(readFileSync(compatFile, 'utf8'));
  const target = {};
  for (const e of compat.engines) {
    const tags = latest(e.engine);
    const wanted = opt(`--${e.engine}`);
    const pick = wanted ? tags.find((t) => t.tag === wanted) : tags.at(-1);
    if (!pick) throw new Error(`${e.engine}: tag ${wanted ?? '(latest)'} not found`);
    target[e.engine] = { ...pick, current: e.ref };
  }
  const newer = Object.entries(target).filter(([, t]) => t.tag !== t.current);
  const lines = [`# Compatibility matrix vs engine releases (${new Date().toISOString().slice(0, 10)})`, ''];
  for (const [engine, t] of Object.entries(target)) lines.push(`- ${engine}: matrix ${t.current}, latest ${t.tag}${t.tag === t.current ? ' (up to date)' : ''}`);
  if (newer.length === 0) {
    console.log(lines.join('\n'));
    return 0;
  }
  const tagFlags = newer.flatMap(([engine, t]) => [`--${engine}`, t.tag]);
  const anchors = run(['--anchors', ...tagFlags, '--rebase']);
  const registry = run(['--registry', ...tagFlags]);
  const clean = anchors.code === 0;
  const after = JSON.parse(readFileSync(compatFile, 'utf8'));
  if (clean) {
    for (const [engine, t] of newer) {
      const e = after.engines.find((x) => x.engine === engine);
      Object.assign(e, { version: t.tag.replace(/^v/, ''), ref: t.tag, commit: t.commit });
    }
    after.checkedOn = new Date().toISOString().slice(0, 10);
    writeFileSync(compatFile, `${JSON.stringify(after, null, 2)}\n`);
  }
  lines.push(
    '',
    clean
      ? `Every cited line of engine code was found at the new tag(s): sources and "engines" moved to ${newer.map(([e, t]) => `${e} ${t.tag}`).join(', ')}.`
      : 'Some cited lines vanished or moved ambiguously: the sources found were moved, "engines" was NOT updated. Verify the rules below, then update "engines" by hand.',
    '',
    '## Code anchors',
    '',
    '```',
    anchors.out || '(no output)',
    '```',
    '',
    '## Model registries',
    '',
    '```',
    registry.out || '(no output)',
    '```',
    '',
    'Not covered by this check: the KV cache layout in src/model/vllm-kv.ts and the speed calibration, both pinned to the version they were written for.',
  );
  const report = `${lines.join('\n')}\n`;
  console.log(report);
  const reportFile = opt('--report');
  if (reportFile) writeFileSync(reportFile, report);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e.message);
      process.exitCode = 2;
    },
  );
}
