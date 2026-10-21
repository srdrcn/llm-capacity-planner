import { afterAll, describe, expect, it } from 'vitest';
import { catalog } from '../../src/cli/run';
import { figuresSchema, type Figures } from '../../src/cli/figures';
import { plan, planArgs, planRequestSchema } from '../../src/web/api';
import { cardSizing, memoryAnswer, memoryLayout } from '../../src/web/summary';
import { catalogBuiltin, HUB, noNetwork, runCli, tempFolder } from '../helpers/catalog';
import { fakeHub } from '../cli/fixtures';

const tmp = tempFolder('web-api-');
afterAll(tmp.cleanup);
const GPUS = catalog();
const deps = (over: Partial<Parameters<typeof plan>[1]> = {}) => ({
  fetch: noNetwork,
  env: {},
  baseUrl: HUB,
  cacheDir: tmp.dir,
  platform: 'linux' as const,
  builtin: catalogBuiltin(),
  localGpu: () => Promise.resolve(undefined),
  ...over,
});
const MODEL = 'Qwen/Qwen3.8-27B';

describe('plan request', () => {
  it('maps every option to the command', () => {
    const r = planRequestSchema.parse({ model: MODEL, tokens: '128k', typicalTokens: 8192, variant: 'fp8', textOnly: true, refresh: true, engine: 'sglang', cache: 'auto' });
    expect(planArgs(r, 'x.json')).toEqual([MODEL, '--engine', 'sglang', '--cache', 'auto', '--json', 'x.json', '--no-color', '--tokens', '128k', '--typical-context', '8192', '--variant', 'fp8', '--text-only', '--refresh']);
    expect(planArgs(planRequestSchema.parse({ model: MODEL }), 'x.json')).toEqual([MODEL, '--engine', 'vllm', '--cache', 'fp8', '--json', 'x.json', '--no-color']);
  });

  it('rejects a bad body with the field at fault', async () => {
    const r = await plan({ model: '', tokens: 'lots', extra: 1 }, deps(), GPUS);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.ok || r.message).toMatch(/model/);
    expect(await plan(null, deps(), GPUS)).toMatchObject({ ok: false, status: 400 });
    expect((await plan(null, deps(), GPUS) as { message: string }).message).toMatch(/^body:/);
  });

  it('answers the command message: 404 for an unknown model, 422 for an error', async () => {
    const missing = await plan({ model: 'nobody/nothing' }, deps({ fetch: fakeHub({}, []), builtin: undefined }), GPUS);
    expect(missing).toMatchObject({ ok: false, status: 404 });
    expect((missing as { message: string }).message).toMatch(/does not exist/);
    const tooLong = await plan({ model: MODEL, tokens: '8k', typicalTokens: '16k' }, deps(), GPUS);
    expect(tooLong).toMatchObject({ ok: false, status: 422 });
    expect((tooLong as { message: string }).message).toMatch(/typical-context/);
    expect((tooLong as { message: string }).message).not.toMatch(/^Error/);
    const offline = await plan({ model: 'someone/not-built-in' }, deps({ builtin: undefined }), GPUS);
    expect(offline).toMatchObject({ ok: false, status: 502 });
    expect((offline as { message: string }).message).toMatch(/HTTPS_PROXY/);
    expect((offline as { message: string }).message).not.toMatch(/--offline/);
  });
});

describe('memory answer', () => {
  it('sizes a built-in model on every card, smallest first', async () => {
    const r = await plan({ model: MODEL, tokens: '128k' }, deps());
    if (!r.ok) throw new Error(r.message);
    expect(r.plan.concurrent).toBeUndefined();
    expect(r.plan.cards).toHaveLength(GPUS.length);
    const first = r.plan.cards[0]!;
    expect(first.minimal?.gpusPerCopy).toBe(1);
    expect(first.forLoad).toBeUndefined();
    expect(first.minimal!.weightsGiB).toBeGreaterThan(40);
    expect(r.plan.cards.at(-1)!.minimal).toBeUndefined();
    expect(r.plan.cards.at(-1)!.reason).toMatch(/does not fit/);
  });

  it('sizes copies, GPUs and servers for a load', async () => {
    const r = await plan({ model: MODEL, tokens: '128k', concurrent: 500 }, deps(), GPUS);
    if (!r.ok) throw new Error(r.message);
    expect(r.plan.concurrent).toBe(500);
    const h200 = r.plan.cards.find((c) => c.gpuId === 'h200-sxm-141gb')!;
    const f = h200.forLoad!;
    expect(f.copies * f.layout.concurrent).toBeGreaterThanOrEqual(500);
    expect(f.gpus).toBe(f.copies * f.layout.gpusPerCopy);
    expect(f.servers).toBe(Math.ceil(f.copies / Math.floor(8 / f.layout.gpusPerCopy)));
    const gpus = r.plan.cards.map((c) => c.forLoad?.gpus ?? Infinity);
    expect([...gpus].sort((a, b) => a - b)).toEqual(gpus);
  });
});

describe('memory layouts', async () => {
  const { written } = await runCli([MODEL, '--tokens', '128k', '--json', 'p.json'], tmp.dir);
  const json = JSON.parse(written['p.json']!) as { rows: unknown[] };
  const rows = json.rows.map((r) => figuresSchema.parse(r));
  const h200 = GPUS.find((g) => g.id === 'h200-sxm-141gb')!;
  const one = rows.find((r) => r.gpuId === h200.id && r.count === 1 && r.replicas === 1)!;
  const edit = (f: Figures, over: Partial<Figures>): Figures => ({ ...f, ...over });

  it('keeps single copies that fit and start', () => {
    expect(memoryLayout(one, 0.85)).toMatchObject({ gpusPerCopy: 1, pipeline: false });
    expect(memoryLayout(edit(one, { replicas: 2 }), 0.85)).toBeUndefined();
    expect(memoryLayout(edit(one, { memoryFits: false }), 0.85)).toBeUndefined();
    expect(memoryLayout(edit(one, { compat: { status: 'does-not-start', notes: ['no'] } }), 0.85)).toBeUndefined();
    expect(memoryLayout(edit(one, { requests: undefined }), 0.85)?.concurrent).toBe(0);
  });

  it('says why a card has no layout', () => {
    expect(cardSizing(h200, [edit(one, { compat: { status: 'does-not-start', notes: [] } })], 0.85).reason).toMatch(/engine does not start/);
    expect(cardSizing(h200, [], 0.85)).toMatchObject({ gpu: h200.name, cardGiB: 0, reason: expect.stringMatching(/does not fit/) });
    const empty = edit(one, { requests: { guaranteed: 0, likely: 0, memory: 0, limitedBy: 'memory' } });
    expect(cardSizing(h200, [empty], 0.85, 4).reason).toMatch(/holds no full request/);
  });

  it('prefers fewer GPUs, no pipeline, then more room', () => {
    const big = (n: number) => ({ guaranteed: 0, likely: 0, memory: n, limitedBy: 'memory' as const });
    const pp = edit(one, { count: 2, tp: 1, pp: 2, requests: big(100) });
    const tp = edit(one, { count: 2, tp: 2, pp: 1, requests: big(50) });
    const tp2 = edit(tp, { requests: big(60) });
    expect(cardSizing(h200, [pp, tp], 0.85).minimal).toMatchObject({ tp: 2, pp: 1 });
    expect(cardSizing(h200, [tp, tp2], 0.85).minimal?.concurrent).toBe(51);
    // Same GPU total for the load: the better layout wins the tie.
    expect(cardSizing(h200, [pp, tp], 1, 40).forLoad).toMatchObject({ copies: 1, gpus: 2, layout: { pp: 1 } });
  });

  it('orders cards that fit before those that do not', () => {
    const a = memoryAnswer({ ...json, rows: rows.filter((r) => r.gpuId === h200.id) }, [GPUS[0]!, h200]);
    expect(a.cards.map((c) => c.gpuId)).toEqual([h200.id, GPUS[0]!.id]);
  });
});
