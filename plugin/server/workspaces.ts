import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Workspace } from './protocol/workspace.ts';
import { writeFileAtomic } from './collector/state-store.ts';
import type { repositoryReads } from './route.ts';

type WorkspaceScope = ReturnType<typeof repositoryReads>;
export const DIFF_BACKOFF_MS = 30 * 60_000;
const directory = z.object({
  signature: z.string().nullable(),
  snapshot: Workspace.nullable(),
  retryAfter: z.number(),
});
export type UnknownFileCount = Pick<Workspace, 'root' | 'branch' | 'ahead' | 'behind'> & { isDirty: boolean | null };
type Directory = z.output<typeof directory>;
const cache = z.object({
  version: z.literal(2),
  roots: z.record(z.string(), z.string()),
  directories: z.record(z.string(), directory),
});

export class RemoteWorkspaces {
  private readonly path: string;
  private readonly roots = new Map<string, string>();
  private readonly directories = new Map<string, Directory>();
  private readonly pending = new Map<string, Promise<Directory>>();
  readonly unknownCounts = new Map<string, UnknownFileCount>();
  private readonly scope: WorkspaceScope;

  constructor(scope: WorkspaceScope, dir: string) {
    this.scope = scope;
    this.path = join(dir, 'workspace-snapshots.json');
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (raw && typeof raw === 'object' && 'version' in raw && raw.version === 2) {
      const state = cache.parse(raw);
      for (const [id, root] of Object.entries(state.roots)) this.roots.set(id, root);
      for (const [root, data] of Object.entries(state.directories)) this.directories.set(root, data);
    } else {
      // Pre-change snapshots have no diffStat. Keep them as fallback and establish the signature on first read.
      for (const [id, w] of Object.entries(z.record(z.string(), Workspace).parse(raw))) {
        this.roots.set(id, w.root);
        const existing = this.directories.get(w.root)?.snapshot;
        if (!existing || w.checked_at > existing.checked_at) this.directories.set(w.root, { signature: null, snapshot: w, retryAfter: 0 });
      }
    }
  }

  private save() {
    writeFileAtomic(this.path, JSON.stringify({
      version: 2, roots: Object.fromEntries(this.roots), directories: Object.fromEntries(this.directories),
    }));
  }

  async read(id: string, now: () => Date): Promise<Workspace | null> {
    let w;
    try { w = await this.scope.workspace(id); }
    catch { return this.directories.get(this.roots.get(id) ?? '')?.snapshot ?? null; }
    const root = w?.workspaceDirectory ?? (w?.workspaceKind === 'worktree' ? null : w?.projectRootPath);
    const git = w?.gitRuntime;
    if (!w || !root || !git || w.projectKind === 'non_git') { this.unknownCounts.delete(id); return null; }

    const signature = JSON.stringify([git.isDirty ?? null, w.diffStat?.additions ?? null, w.diffStat?.deletions ?? null]);
    const fields: UnknownFileCount = {
      root, branch: git.currentBranch ?? null, ahead: git.aheadOfOrigin ?? null,
      behind: git.behindOfOrigin ?? null, isDirty: git.isDirty ?? null,
    };

    // Two workspace IDs can name one checkout. Recheck its signature after an in-flight observation commits.
    while (this.pending.has(root)) await this.pending.get(root);
    const newRoot = this.roots.get(id) !== root;
    this.roots.set(id, root);
    const task = this.updateDirectory(fields, signature, newRoot, now);
    this.pending.set(root, task);
    try {
      const state = await task;
      if (state.retryAfter) this.unknownCounts.set(id, fields);
      else this.unknownCounts.delete(id);
      return state.snapshot;
    } finally {
      this.pending.delete(root);
    }
  }

  private async updateDirectory(fields: UnknownFileCount, signature: string, newRoot: boolean, now: () => Date): Promise<Directory> {
    const { root, branch, ahead, behind, isDirty } = fields;
    const state = this.directories.get(root) ?? { signature: null, snapshot: null, retryAfter: 0 };
    const at = now().getTime();
    if (at < state.retryAfter) {
      if (newRoot) this.save();
      return state;
    }

    const last = state.snapshot;
    const reuse = last !== null && state.signature === signature && state.retryAfter === 0;
    if (reuse && !newRoot && last.branch === branch && last.ahead === ahead && last.behind === behind) return state;

    let count: number | null;
    if (reuse) count = last.dirty;
    else if (isDirty === false) count = 0;
    else count = await this.scope.changedFileCount(root).catch(() => null);

    if (count === null) {
      state.retryAfter = now().getTime() + DIFF_BACKOFF_MS;
    } else {
      state.snapshot = { root, branch, ahead, behind, dirty: count, recent: [], checked_at: reuse ? last.checked_at : new Date(at).toISOString() };
      state.signature = signature;
      state.retryAfter = 0;
    }
    this.directories.set(root, state);
    this.save();
    return state;
  }
}
