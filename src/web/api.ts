/**
 * The web service's API, independent of HTTP: a plan request is validated, turned into the command's own arguments,
 * run in-process with cli/run.ts (the JSON answer captured instead of written to a file) and reduced to memory by
 * summary.ts. Every network access goes through the deps given, as in the command.
 */
import { z } from 'zod';
import { USAGE } from '../cli/args';
import { catalog, runPlan, type PlanDeps } from '../cli/run';
import type { Gpu } from '../planner/hardware';
import { memoryAnswer, type MemoryAnswer } from './summary';

const tokens = z.union([z.number().int().positive(), z.string().regex(/^\d+(\.\d+)?[kKmM]?$/)]);

export const planRequestSchema = z
  .object({
    /** Hugging Face repo id, e.g. "Qwen/Qwen3-32B" (or words to search for). */
    model: z.string().trim().min(1).max(200),
    /** Context of one request: prompt + history + answer ("128k" or a number). Default: the model's maximum. */
    tokens: tokens.optional(),
    /** Tokens of a typical request, which sizes the KV cache shared by concurrent requests. Default: half the context. */
    typicalTokens: tokens.optional(),
    /** Requests generating at the same moment, to size copies, GPUs and servers. */
    concurrent: z.number().int().positive().max(1_000_000).optional(),
    engine: z.enum(['vllm', 'sglang']).default('vllm'),
    cache: z.enum(['fp8', 'auto']).default('fp8'),
    /** Folder of the checkpoint inside the repo (quantized variants). */
    variant: z.string().max(200).optional(),
    /** Only the language model (vision encoder left out). */
    textOnly: z.boolean().default(false),
    /** Read the model from Hugging Face again instead of the built-in or cached copy. */
    refresh: z.boolean().default(false),
  })
  .strict();
export type PlanRequest = z.input<typeof planRequestSchema>;

/** What a plan answers: the memory sizing, or the command's message (not found, gated, search suggestions…). */
export type PlanResult = { ok: true; plan: MemoryAnswer } | { ok: false; status: number; message: string };

/** The command's arguments for a request. */
export function planArgs(r: z.output<typeof planRequestSchema>, jsonFile: string): string[] {
  const args = [r.model, '--engine', r.engine, '--cache', r.cache, '--json', jsonFile, '--no-color'];
  if (r.tokens !== undefined) args.push('--tokens', String(r.tokens));
  if (r.typicalTokens !== undefined) args.push('--typical-context', String(r.typicalTokens));
  if (r.variant) args.push('--variant', r.variant);
  if (r.textOnly) args.push('--text-only');
  if (r.refresh) args.push('--refresh');
  return args;
}

const JSON_FILE = 'plan.json';

/** Runs one plan request. */
export async function plan(body: unknown, deps: Omit<PlanDeps, 'out' | 'writeFile' | 'isTTY'>, gpus: readonly Gpu[] = deps.gpus ?? catalog()): Promise<PlanResult> {
  const parsed = planRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
  const r = parsed.data;
  const said: string[] = [];
  let written: string | undefined;
  const code = await runPlan(planArgs(r, JSON_FILE), {
    ...deps,
    isTTY: false,
    out: (t) => said.push(t),
    writeFile: (_file, content) => {
      written = content;
      return Promise.resolve();
    },
  });
  if (code !== 0 || written === undefined) {
    // The command's own message, without its usage text and the "JSON written to" line.
    const message = said
      .join('\n')
      .replace(USAGE, '')
      .replace(/^Error: /, '')
      .trim();
    // Hugging Face unreachable is the service's problem, not the request's; the CLI's --offline advice does not apply.
    if (message.startsWith('Hugging Face does not answer')) return { ok: false, status: 502, message: message.replace(/ Try again, or use --offline.*$/, ' Check the proxy (HTTPS_PROXY) or HF_ENDPOINT.') };
    return { ok: false, status: code === 2 ? 404 : 422, message };
  }
  return { ok: true, plan: memoryAnswer(JSON.parse(written), gpus, r.concurrent) };
}
