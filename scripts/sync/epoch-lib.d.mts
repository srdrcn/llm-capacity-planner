/** Types of scripts/sync/epoch-lib.mjs (for the tests). */
export type Row = Record<string, string>;
export interface Diff { field: string; ours: number | null; epoch: number | string | null; unit?: string; pct?: number; note?: string }
export interface Draft {
  id: string;
  name: string;
  epoch: {
    releaseDate: string | null;
    lastModified: string | null;
    vramGB: number | null;
    memoryBandwidthGBs: number | null;
    tflops: { bf16: number | null; fp8: number | null; fp4: number | null };
    intranodeGBs: number | null;
    tdpW: number | null;
    datasheet: string | null;
  };
  todo: string[];
}
export interface Comparison { mapped: { name: string; id: string; diffs: Diff[] }[]; added: Draft[]; gone: string[]; orphans: string[] }
export interface EpochMap { map: Record<string, string>; ignore: Record<string, string> }
export function parseCsv(text: string): Row[];
export function num(v: unknown): number | null;
export const COL: Record<'name' | 'maker' | 'type' | 'release' | 'memory' | 'bandwidth' | 'bf16' | 'fp8' | 'fp4' | 'intranode' | 'tdp' | 'datasheet' | 'modified', string>;
export function missingColumns(rows: Row[]): string[];
export function formatsFromCompute(cc: string | number | null): { fp8: boolean; nvfp4: boolean; mxfp4: boolean; mxfp8: boolean } | null;
export function slug(name: string): string;
export function compare(rows: Row[], hardware: { gpus: { id: string; vramGBNominal: number; memoryBandwidthGBs: number }[] }, map: EpochMap, opts?: { tolerance?: number }): Comparison;
export function draftEntry(r: Row): Draft;
export function reportMarkdown(result: Comparison, meta: { source: string; checkedOn: string }): string;
export function needsAttention(r: Comparison): boolean;
