// Pure functions of scripts/sync/epoch.mjs: reading Epoch AI's ML hardware CSV and comparing it with hardware.json.
// No network and no files here (test/sync/epoch.test.ts runs them on a fixture).

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. Rows as objects by header. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** A number of the CSV ("1.2e+12", "" → null). */
export function num(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Column names of the Epoch export (checked on 2026-10-21). */
export const COL = {
  name: 'Hardware name',
  maker: 'Manufacturer',
  type: 'Type',
  release: 'Release date',
  memory: 'Memory (bytes)',
  bandwidth: 'Memory bandwidth (byte/s)',
  bf16: 'Tensor-FP16/BF16 performance (FLOP/s)',
  fp8: 'FP8 performance (FLOP/s)',
  fp4: 'FP4 performance (FLOP/s)',
  intranode: 'Intranode bandwidth (byte/s)',
  tdp: 'TDP (W)',
  datasheet: 'Link to datasheet',
  modified: 'Last modified',
};

/** Columns this sync needs: an export without them has changed shape and must be looked at. */
export function missingColumns(rows) {
  const first = rows[0];
  if (!first) return Object.values(COL);
  return [COL.name, COL.maker, COL.memory, COL.bandwidth].filter((c) => !(c in first));
}

/**
 * Weight and KV formats a card computes natively, from its CUDA compute capability: FP8 from Ada / Hopper (8.9),
 * the microscaled 4- and 8-bit formats (NVFP4, MXFP4, MXFP8) from Blackwell (10.0). hardware.json states them per
 * card from the datasheets; for a new card this is the draft, to be checked against its datasheet.
 */
export function formatsFromCompute(cc) {
  const v = num(cc);
  if (v === null) return null;
  const blackwell = v >= 10;
  return { fp8: v >= 8.9, nvfp4: blackwell, mxfp4: blackwell, mxfp8: blackwell };
}

/** "NVIDIA VR200 (Vera Rubin)" → "vr200-vera-rubin". */
export function slug(name) {
  return name
    .replace(/^NVIDIA\s+/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const GB = 1e9;
const round = (x, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Relative difference of two values, null when one is missing. */
function relDiff(ours, theirs) {
  if (ours === null || theirs === null || ours === undefined || theirs === undefined || theirs === 0) return null;
  return Math.abs(ours - theirs) / theirs;
}

/**
 * Compares Epoch's NVIDIA rows with the catalog.
 *   mapped   rows paired with a catalog card, with every field that differs by more than `tolerance`
 *   added    NVIDIA rows neither mapped nor ignored: new cards, with a draft entry from Epoch's values
 *   gone     names of the map Epoch no longer lists (renamed upstream?)
 *   orphans  catalog cards no Epoch row is mapped to (informational: Epoch does not list every card)
 */
export function compare(rows, hardware, map, { tolerance = 0.03 } = {}) {
  const nvidia = rows.filter((r) => /nvidia/i.test(r[COL.maker] ?? ''));
  const byId = new Map(hardware.gpus.map((g) => [g.id, g]));
  const seen = new Set(nvidia.map((r) => r[COL.name]));
  const mapped = [];
  const added = [];
  for (const r of nvidia) {
    const name = r[COL.name];
    if (name in map.ignore) continue;
    const id = map.map[name];
    if (id === undefined) {
      added.push(draftEntry(r));
      continue;
    }
    const g = byId.get(id);
    if (!g) {
      mapped.push({ name, id, diffs: [{ field: 'id', ours: null, epoch: id, note: 'the map names a card hardware.json does not have' }] });
      continue;
    }
    const diffs = [];
    const check = (field, ours, theirs, unit) => {
      const d = relDiff(ours, theirs);
      if (d !== null && d > tolerance) diffs.push({ field, ours, epoch: round(theirs), unit, pct: round(d * 100) });
    };
    const mem = num(r[COL.memory]);
    check('vramGBNominal', g.vramGBNominal, mem === null ? null : mem / GB, 'GB');
    const bw = num(r[COL.bandwidth]);
    check('memoryBandwidthGBs', g.memoryBandwidthGBs, bw === null ? null : bw / GB, 'GB/s');
    mapped.push({ name, id, diffs });
  }
  const gone = Object.keys(map.map).filter((n) => !seen.has(n));
  const covered = new Set(Object.values(map.map));
  const orphans = hardware.gpus.map((g) => g.id).filter((id) => !covered.has(id));
  return { mapped, added, gone, orphans };
}

/** A draft catalog entry for a new card, from Epoch's row: to be completed from NVIDIA's datasheet. */
export function draftEntry(r) {
  const tf = (col) => {
    const v = num(r[col]);
    return v === null ? null : round(v / 1e12);
  };
  const mem = num(r[COL.memory]);
  const bw = num(r[COL.bandwidth]);
  const link = num(r[COL.intranode]);
  return {
    id: slug(r[COL.name]),
    name: r[COL.name],
    epoch: {
      releaseDate: r[COL.release] || null,
      lastModified: r[COL.modified] || null,
      vramGB: mem === null ? null : round(mem / GB),
      memoryBandwidthGBs: bw === null ? null : round(bw / GB, 0),
      // Epoch does not say whether these include 2:4 sparsity: compare with the datasheet before using them.
      tflops: { bf16: tf(COL.bf16), fp8: tf(COL.fp8), fp4: tf(COL.fp4) },
      intranodeGBs: link === null ? null : round(link / GB, 0),
      tdpW: num(r[COL.tdp]),
      datasheet: r[COL.datasheet] || null,
    },
    todo: ['computeCapability (https://developer.nvidia.com/cuda-gpus) → formats', 'CUDA-visible memory', 'NVLink generation and domain', 'GPUs per server', 'sources per field'],
  };
}

/** The report as Markdown (issue or pull-request body). */
export function reportMarkdown(result, { source, checkedOn }) {
  const out = [`# GPU catalog vs Epoch AI (${checkedOn})`, '', `Source: ${source} (Epoch AI, CC BY 4.0).`, ''];
  const changed = result.mapped.filter((m) => m.diffs.length > 0);
  out.push(`## New NVIDIA cards (${result.added.length})`, '');
  if (result.added.length === 0) out.push('None.');
  for (const a of result.added) {
    const e = a.epoch;
    out.push(`- **${a.name}** (draft id \`${a.id}\`): ${e.vramGB ?? '?'} GB, ${e.memoryBandwidthGBs ?? '?'} GB/s, BF16 ${e.tflops.bf16 ?? '?'} / FP8 ${e.tflops.fp8 ?? '?'} / FP4 ${e.tflops.fp4 ?? '?'} TFLOPS, released ${e.releaseDate ?? '?'}${e.datasheet ? ` — [datasheet](${e.datasheet})` : ''}`);
  }
  out.push('', `## Values that differ (${changed.length})`, '');
  if (changed.length === 0) out.push('None.');
  for (const m of changed) for (const d of m.diffs) out.push(`- \`${m.id}\` ${d.field}: catalog ${d.ours}${d.unit ? ` ${d.unit}` : ''}, Epoch ${d.epoch}${d.unit ? ` ${d.unit}` : ''}${d.pct !== undefined ? ` (${d.pct} %)` : ''}${d.note ? ` — ${d.note}` : ''}`);
  if (result.gone.length) out.push('', `## Names Epoch no longer lists (${result.gone.length})`, '', ...result.gone.map((n) => `- ${n} (renamed? fix data/epoch-map.json)`));
  out.push('', `Catalog cards without an Epoch row: ${result.orphans.length ? result.orphans.join(', ') : 'none'}.`);
  out.push('', 'New cards are written as drafts to `data/pending-gpus.json`: complete them from the NVIDIA datasheet, move them to `data/hardware.json` and run `npm test`. Catalog values come from NVIDIA datasheets; a difference is a prompt to re-check, not an automatic change.');
  return out.join('\n') + '\n';
}

/** Whether the report asks for a look (exit code 1 in CI). */
export const needsAttention = (r) => r.added.length > 0 || r.gone.length > 0 || r.mapped.some((m) => m.diffs.length > 0);
