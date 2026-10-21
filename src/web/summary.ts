/**
 * Memory-only sizing for the web service: the planner's JSON answer (cli/render.ts renderJson) reduced to what
 * memory decides, with no speed figure. For every card of the catalog: the smallest layout whose weights, KV cache
 * and fixed costs fit, how many requests its KV cache holds at once, and, for a number of concurrent requests, how
 * many copies of the model, GPUs and servers that takes.
 *
 * Speed, time to first token and the users the planner derives from them are left out on purpose: they rest on a
 * calibration this service does not show (they stay in the CLI's output).
 */
import { z } from 'zod';
import { figuresSchema, type Figures } from '../cli/figures';
import { serverSize, type Gpu } from '../planner/hardware';

/** The part of renderJson's output this module reads (the rest is ignored). */
export const planJsonSchema = z.object({
  model: z.object({
    repo: z.string(),
    variant: z.string(),
    format: z.string(),
    family: z.string(),
    engine: z.string(),
    cache: z.string(),
    workload: z.object({ maxContext: z.number(), typicalContext: z.number(), safety: z.number() }).passthrough(),
    modelMaxContext: z.number().optional(),
    documentedMaxContext: z.number().optional(),
    hasVision: z.boolean(),
    textOnly: z.boolean(),
    compatChecked: z.boolean(),
    verification: z.object({ status: z.string() }).passthrough(),
    source: z.object({ kind: z.string() }).passthrough(),
  }),
  rows: z.array(figuresSchema),
});
export type PlanJson = z.infer<typeof planJsonSchema>;

/** One way to run the model on a card: a single copy on `gpusPerCopy` GPUs. */
export interface MemoryLayout {
  gpusPerCopy: number;
  tp: number;
  pp: number;
  /** Weights per GPU, GiB (exact: summed from the safetensors headers). */
  weightsGiB: number;
  /** KV cache of one full-context request per GPU, GiB (exact). */
  kvPerRequestGiB: number;
  /** CUDA context, activations, CUDA graphs and workspaces per GPU, GiB: [min, max]. */
  fixedGiB: [number, number];
  /** Room the engine has per GPU (its --gpu-memory-utilization share), GiB. */
  engineGiB: number;
  /** Requests whose KV cache fits at once at the typical context, after the safety margin. */
  concurrent: number;
  /** Pipeline stages are used and the engine is not verified for them on this model. */
  pipeline: boolean;
  compat: { status: string; notes: string[] };
}

export interface CardSizing {
  gpuId: string;
  gpu: string;
  segment: string;
  cardGiB: number;
  /** GPUs one server of this card holds. */
  serverGpus: number;
  /** The smallest layout that fits, or undefined when none fits up to one full server. */
  minimal?: MemoryLayout;
  /** For the concurrent requests asked: the layout and count of copies with the fewest GPUs in total. */
  forLoad?: { layout: MemoryLayout; copies: number; gpus: number; servers: number };
  /** Why nothing fits, when nothing does. */
  reason?: string;
}

export interface MemoryAnswer {
  model: PlanJson['model'];
  /** Concurrent requests the plan was sized for (undefined: only the smallest layouts). */
  concurrent?: number;
  cards: CardSizing[];
}

const compatOf = (f: Figures) => ({ status: f.compat.status, notes: [...f.compat.notes] });

/** A row as a memory layout; undefined when it does not fit or the engine cannot start it. */
export function memoryLayout(f: Figures, safety: number): MemoryLayout | undefined {
  if (f.replicas !== 1 || !f.memoryFits) return undefined;
  const compat = compatOf(f);
  if (compat.status === 'does-not-start') return undefined;
  return {
    gpusPerCopy: f.count,
    tp: f.tp,
    pp: f.pp,
    weightsGiB: f.weights.value,
    kvPerRequestGiB: f.kv.value,
    fixedGiB: [f.fixed.min, f.fixed.max],
    engineGiB: f.engineGiB.value,
    concurrent: Math.max(0, Math.floor((f.requests?.memory ?? 0) * safety)),
    pipeline: f.pp > 1,
    compat,
  };
}

/** Fewer GPUs first, then without pipeline stages, then more room for requests. */
function better(a: MemoryLayout, b: MemoryLayout): number {
  return a.gpusPerCopy - b.gpusPerCopy || Number(a.pipeline) - Number(b.pipeline) || b.concurrent - a.concurrent;
}

/** Sizing of one card from the rows of its layouts. */
export function cardSizing(gpu: Gpu, rows: readonly Figures[], safety: number, concurrent?: number): CardSizing {
  const mine = rows.filter((r) => r.gpuId === gpu.id);
  const first = mine[0];
  const base = {
    gpuId: gpu.id,
    gpu: first?.gpu ?? gpu.name,
    segment: gpu.segment,
    cardGiB: first?.cardGiB ?? 0,
    serverGpus: serverSize(gpu),
  };
  const layouts = mine
    .map((r) => memoryLayout(r, safety))
    .filter((l): l is MemoryLayout => l !== undefined)
    .sort(better);
  const minimal = layouts[0];
  if (!minimal) {
    const blocked = mine.some((r) => r.memoryFits && compatOf(r).status === 'does-not-start');
    return { ...base, reason: blocked ? 'the engine does not start this model on this card' : `does not fit, even on ${base.serverGpus} GPUs` };
  }
  const result: CardSizing = { ...base, minimal };
  if (concurrent === undefined) return result;
  let best: CardSizing['forLoad'];
  for (const l of layouts) {
    if (l.concurrent < 1) continue;
    const copies = Math.ceil(concurrent / l.concurrent);
    const gpus = copies * l.gpusPerCopy;
    // Copies never span servers: a server holds floor(serverGpus / gpusPerCopy) of them.
    const perServer = Math.max(1, Math.floor(base.serverGpus / l.gpusPerCopy));
    const servers = Math.ceil(copies / perServer);
    if (!best || gpus < best.gpus || (gpus === best.gpus && better(l, best.layout) < 0)) best = { layout: l, copies, gpus, servers };
  }
  if (best) result.forLoad = best;
  else result.reason = 'the KV cache holds no full request beside the weights';
  return result;
}

/** The memory-only answer for every card of the catalog, cards that fit first (fewest GPUs, then most memory). */
export function memoryAnswer(json: unknown, gpus: readonly Gpu[], concurrent?: number): MemoryAnswer {
  const plan = planJsonSchema.parse(json);
  const safety = plan.model.workload.safety;
  const cards = gpus.map((g) => cardSizing(g, plan.rows, safety, concurrent));
  const key = (c: CardSizing) => (concurrent !== undefined ? c.forLoad?.gpus : c.minimal?.gpusPerCopy) ?? Number.POSITIVE_INFINITY;
  cards.sort((a, b) => key(a) - key(b) || b.cardGiB - a.cardGiB);
  return { model: plan.model, ...(concurrent !== undefined ? { concurrent } : {}), cards };
}
