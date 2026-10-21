import { describe, expect, it } from 'vitest';
import { stableTags } from '../../scripts/sync/compat.mjs';

const c = (n: number) => String(n).repeat(40).slice(0, 40);

describe('engine release tags', () => {
  it('keeps stable tags in version order, with the commit of annotated tags', () => {
    const out = [
      `${c(1)}\trefs/tags/v0.31.0`,
      `${c(2)}\trefs/tags/v0.32.0`,
      `${c(3)}\trefs/tags/v0.32.0^{}`,
      `${c(4)}\trefs/tags/v0.9.1`,
      `${c(5)}\trefs/tags/v0.33.0rc1`,
      `${c(6)}\trefs/tags/nightly`,
      '',
    ].join('\n');
    expect(stableTags(out)).toEqual([
      { tag: 'v0.9.1', commit: c(4) },
      { tag: 'v0.31.0', commit: c(1) },
      { tag: 'v0.32.0', commit: c(3) },
    ]);
  });
});
