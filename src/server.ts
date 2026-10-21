/**
 * Entry of the web service: `node out/server.mjs` (scripts/build-server.mjs), the page and its JSON API.
 *
 *   GET  /              the page (src/web/index.html)
 *   GET  /api/meta      engine versions, catalog dates, built-in models
 *   GET  /api/gpus      the GPU catalog (data/hardware.json)
 *   POST /api/plan      memory sizing of a Hugging Face model (src/web/api.ts planRequestSchema)
 *   GET  /healthz       liveness / readiness
 *
 * Like main.ts this only wires the process (port, environment, network, files) into web/api.ts, which the tests
 * cover. Environment: PORT (8080), HF_TOKEN, HF_ENDPOINT, HTTPS_PROXY / NO_PROXY, XDG_CACHE_HOME (where Hugging
 * Face answers are kept), PLAN_CONCURRENCY (4 plans at once).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import compatJson from '../data/compat.json';
import hardwareJson from '../data/hardware.json';
import { builtinModels, readPack, type BuiltinModels } from './cli/builtin';
import { findHfToken } from './cli/hf-token';
import { catalog } from './cli/run';
import { plan, type PlanResult } from './web/api';
import page from './web/index.html';

const env = process.env;

// Node's fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1, set before Node starts (as main.ts does).
if ((env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) && env.NODE_USE_ENV_PROXY !== '1') {
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...env, NODE_USE_ENV_PROXY: '1' } });
  process.exit(r.status ?? 1);
}

const programDir = path.dirname(process.argv[1] ?? '.');
const baseUrl = env.HF_ENDPOINT || 'https://huggingface.co';
const token = findHfToken({ env });
const packBytes = (() => {
  try {
    return readFileSync(path.join(programDir, `${__CLI_NAME__}-models.pack`));
  } catch {
    return undefined;
  }
})();
const builtin: BuiltinModels | undefined = packBytes ? builtinModels(packBytes, baseUrl) : undefined;
const gpus = catalog();
const deps = {
  fetch: globalThis.fetch,
  env: token ? { ...env, HF_TOKEN: token } : env,
  baseUrl,
  platform: process.platform,
  columns: 120,
  gpus,
  // A server has no GPU of its own to plan for (--this-pc is never passed).
  localGpu: () => Promise.resolve(undefined),
  ...(builtin ? { builtin } : {}),
};

const meta = {
  version: __CLI_VERSION__,
  sources: __SOURCE_HASH__,
  engines: compatJson.engines.map((e) => ({ engine: e.engine, version: e.version })),
  compatCheckedOn: compatJson.checkedOn,
  hardwareCheckedOn: hardwareJson.checkedOn,
  builtinModels: packBytes ? { date: readPack(packBytes).index.date, repos: Object.keys(readPack(packBytes).index.repos).sort() } : undefined,
  hfToken: token !== undefined,
};

const gpuList = hardwareJson.gpus.map((g) => ({
  id: g.id,
  name: g.name,
  architecture: g.architecture,
  computeCapability: g.computeCapability,
  vramGB: g.vramGBNominal,
  bandwidthGBs: g.memoryBandwidthGBs,
  formats: g.formats,
  nvlinkDomain: g.nvlink.domainGpus,
  maxPerServer: g.server.maxGpus,
}));

// Answers kept for an hour: the same request reads nothing again (Hugging Face answers are also cached on disk).
const CACHE_MS = 60 * 60 * 1000;
const answers = new Map<string, { at: number; result: PlanResult }>();
function remember(key: string, result: PlanResult): void {
  answers.set(key, { at: Date.now(), result });
  while (answers.size > 200) answers.delete(answers.keys().next().value as string);
}

// A few plans at once: each reads safetensors headers and plans hundreds of layouts.
const MAX_RUNNING = Math.max(1, Number(env.PLAN_CONCURRENCY) || 4);
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, page, 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/meta') return send(res, 200, meta);
  if (req.method === 'GET' && url.pathname === '/api/gpus') return send(res, 200, gpuList);
  if (url.pathname === '/api/plan') {
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
    }
    const key = JSON.stringify(body);
    const kept = answers.get(key);
    const fresh = (body as { refresh?: unknown } | null)?.refresh === true;
    const result = kept && !fresh && Date.now() - kept.at < CACHE_MS ? kept.result : await limited(() => plan(body, deps, gpus));
    if (result.ok) remember(key, result);
    return result.ok ? send(res, 200, result.plan) : send(res, result.status, { error: result.message });
  }
  send(res, 404, { error: 'not found' });
}

const port = Number(env.PORT) || 8080;
createServer((req, res) => {
  handle(req, res).catch((e: unknown) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
}).listen(port, () => console.log(`${__CLI_NAME__} web service on :${port} (${builtin ? `${meta.builtinModels?.repos.length} built-in models` : 'no built-in models'}, HF token ${token ? 'set' : 'not set'})`));
