import type { PluginServerContext } from '@getpaseo/plugin/server';

import { answerQuestion, dismissQuestion } from '../../src/domain/answers.ts';
import { executeUserOperation } from '../../src/domain/execute.ts';
import { snoozeReminder } from '../../src/domain/reminders.ts';
import { OpRejected, type DomainDeps, type OpResult } from '../../src/domain/types.ts';
import type { RunningCenter } from '../../src/server/center.ts';
import { requestSync } from '../../src/server/http.ts';
import {
  boardAnswer, boardApplyMerge, boardDismiss, boardMergePreview, boardOperate, boardPreview, boardSnooze, boardSync,
} from '../shared/board-writes.ts';

type Writer = Pick<RunningCenter, 'db' | 'previews' | 'scheduler'> & { deps: DomainDeps; sources: Parameters<typeof snoozeReminder>[4] };

export function registerBoardWrites(server: Pick<PluginServerContext, 'handle'>, ready: () => Promise<Writer>): void {
  function wakeReview(center: Writer, outcome: OpResult): OpResult {
    if (outcome.status === 'applied' && outcome.project_review_queued) center.scheduler?.requestProjectReview();
    return outcome;
  }
  server.handle(boardOperate, async ({ op, args }) => {
    const center = await ready();
    return wakeReview(center, executeUserOperation(center.db, center.deps, op, args));
  });
  server.handle(boardAnswer, async ({ id, answer }) => {
    const center = await ready();
    return wakeReview(center, answerQuestion(center.db, center.deps, id, answer));
  });
  server.handle(boardDismiss, async ({ id }) => {
    const { db, deps } = await ready();
    return dismissQuestion(db, deps, id);
  });
  server.handle(boardSnooze, async ({ key, hours }) => {
    const { db, deps, sources } = await ready();
    if (!snoozeReminder(db, deps.now(), key, hours, sources)) return { status: 'rejected' as const, code: 'not_found', message: '这条提醒已经不存在' };
    return { ok: true as const };
  });
  server.handle(boardSync, async () => {
    const sync = requestSync((await ready()).scheduler);
    if ('error' in sync) return { status: 'rejected' as const, code: sync.error, message: '理解层未启用，无法同步' };
    return sync;
  });
  server.handle(boardPreview, async ({ source, ...selection }) => {
    const { previews } = await ready();
    try {
      const preview = previews.create(source, selection);
      return 'status' in preview ? preview : { status: 'rejected' as const, code: preview.error, message: preview.message };
    } catch (error) {
      if (error instanceof OpRejected) return { status: 'rejected' as const, code: error.code, message: error.message };
      throw error;
    }
  });
  server.handle(boardMergePreview, async ({ id }) => {
    const preview = (await ready()).previews.read(id);
    if (!preview) throw new Error('找不到合并预览');
    return preview;
  });
  server.handle(boardApplyMerge, async ({ id, overwrite_locked }) => {
    const center = await ready();
    const outcome = center.previews.apply(id, overwrite_locked ?? []);
    if (!outcome) return { status: 'rejected' as const, code: 'not_found', message: '找不到合并预览' };
    return wakeReview(center, outcome);
  });
}
