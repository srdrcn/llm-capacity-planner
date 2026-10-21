import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import hardware from '../../data/hardware.json';
import epochMap from '../../data/epoch-map.json';
import { compare, formatsFromCompute, missingColumns, needsAttention, num, parseCsv, reportMarkdown, slug } from '../../scripts/sync/epoch-lib.mjs';

// A synthetic sample with Epoch's real header (values made up for the test).
const rows = parseCsv(readFileSync('test/fixtures/epoch/ml_hardware-sample.csv', 'utf8'));

describe('Epoch CSV', () => {
  it('parses quoted fields, doubled quotes and both line endings', () => {
    expect(parseCsv('a,b\r\n"x, ""y""",2\n\n3,')).toEqual([{ a: 'x, "y"', b: '2' }, { a: '3', b: '' }]);
    expect(parseCsv('')).toEqual([]);
    const vr = rows.find((r) => r['Hardware name']?.startsWith('NVIDIA VR200'));
    expect(vr?.Notes).toBe('Two dies, "rack-scale", HBM4');
  });

  it('reads numbers and checks the columns it needs', () => {
    expect([num('1.41e+11'), num(''), num(undefined), num('n/a'), num('1,000')]).toEqual([1.41e11, null, null, null, 1000]);
    expect(missingColumns(rows)).toEqual([]);
    expect(missingColumns([{ 'Hardware name': 'x' }])).toContain('Memory (bytes)');
    expect(missingColumns([])).toHaveLength(13);
  });

  it('derives the native formats from the compute capability', () => {
    expect(formatsFromCompute('8.6')).toEqual({ fp8: false, nvfp4: false, mxfp4: false, mxfp8: false });
    expect(formatsFromCompute('9.0')).toEqual({ fp8: true, nvfp4: false, mxfp4: false, mxfp8: false });
    expect(formatsFromCompute(10.3)).toEqual({ fp8: true, nvfp4: true, mxfp4: true, mxfp8: true });
    expect(formatsFromCompute(null)).toBeNull();
    // Every card of the catalog agrees with the rule (its formats come from datasheets).
    for (const g of hardware.gpus) expect(formatsFromCompute(g.computeCapability), g.id).toEqual(g.formats);
  });
});

describe('catalog comparison', () => {
  const result = compare(rows, hardware, epochMap);

  it('reports new cards with a draft, skips ignored rows and other makers', () => {
    expect(result.added.map((a) => a.id)).toEqual(['vr200-vera-rubin']);
    expect(result.added[0]?.epoch).toMatchObject({ vramGB: 288, memoryBandwidthGBs: 22000, tflops: { bf16: null, fp8: 17500, fp4: 50000 }, intranodeGBs: 3600 });
    expect(slug('NVIDIA GB300 (Blackwell Ultra)')).toBe('gb300-blackwell-ultra');
  });

  it('flags values beyond the tolerance only', () => {
    const b200 = result.mapped.find((m) => m.id === 'b200-sxm-180gb');
    expect(b200?.diffs.map((d) => d.field)).toEqual(['vramGBNominal', 'memoryBandwidthGBs']);
    expect(result.mapped.find((m) => m.id === 'h200-sxm-141gb')?.diffs).toEqual([]);
    expect(compare(rows, hardware, epochMap, { tolerance: 0.1 }).mapped.every((m) => m.diffs.length === 0)).toBe(true);
  });

  it('notices a map entry pointing nowhere, renamed rows and unmapped cards', () => {
    const r = compare(rows, hardware, { map: { ...epochMap.map, 'NVIDIA H200 SXM': 'h200-typo' }, ignore: epochMap.ignore });
    expect(r.mapped.find((m) => m.name === 'NVIDIA H200 SXM')?.diffs[0]?.note).toMatch(/does not have/);
    expect(result.gone).toContain('NVIDIA L4');
    expect(result.orphans).toContain('l40s-48gb');
  });

  it('every catalog card mapped exists in hardware.json', () => {
    const ids = new Set(hardware.gpus.map((g) => g.id));
    for (const id of Object.values(epochMap.map)) expect(ids.has(id), id).toBe(true);
  });

  it('writes a report and says when to look', () => {
    const md = reportMarkdown(result, { source: 'sample.csv', checkedOn: '2026-10-21' });
    expect(md).toMatch(/New NVIDIA cards \(1\)/);
    expect(md).toMatch(/b200-sxm-180gb` vramGBNominal: catalog 180 GB, Epoch 192 GB/);
    expect(md).toMatch(/Names Epoch no longer lists/);
    expect(needsAttention(result)).toBe(true);
    const quiet = { mapped: [], added: [], gone: [], orphans: [] };
    expect(needsAttention(quiet)).toBe(false);
    expect(reportMarkdown(quiet, { source: 's', checkedOn: 'd' })).toMatch(/None\.[\s\S]*None\.[\s\S]*without an Epoch row: none/);
  });
});
