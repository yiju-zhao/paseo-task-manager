import { DatabaseSync } from 'node:sqlite';

// The kernel releases SQLite's exclusive transaction on close, process death and reboot.
// The file stays in place so that every contender locks the same inode.
export function exclusiveLock(path: string, busy: () => string): DatabaseSync {
  const guard = new DatabaseSync(path);
  try {
    guard.exec('BEGIN EXCLUSIVE');
    return guard;
  } catch (err) {
    guard.close();
    if ((err as { errcode?: number }).errcode === 5) throw new Error(busy(), { cause: err });
    throw err;
  }
}
