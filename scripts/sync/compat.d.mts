/** Stable release tags (vX.Y.Z) from `git ls-remote --tags` output, oldest first, with the commit each points to. */
export function stableTags(lsRemote: string): { tag: string; commit: string }[];
