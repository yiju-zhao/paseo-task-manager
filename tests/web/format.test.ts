import { expect, test } from 'vitest';
import type { QuestionOptionView } from '../../src/domain/read.ts';
import { entityLabel, entityNames } from '../../src/shared/operation-labels.ts';
import { localTime, preciseTime } from '../../src/shared/board-time.ts';
import { OP_SCHEMAS } from '../../src/domain/ops.ts';
import { OP_LABEL, STATUS_LABEL, actorLabel, describeOption, middleEllipsis, opLabel, relTime, shortDate, shortTime, statusClass } from '../../web/src/format.ts';

test('STATUS_LABEL names every status in Chinese', () => {
  expect(STATUS_LABEL).toEqual({
    working: '运行中',
    blocked: '等你操作',
    idle: '空闲',
    done: '已完成',
    unknown: '未知',
    offline: '离线',
    ended: '已结束',
    purged: '已清除',
  });
});

test('statusClass: working, blocked and offline have their own dot, everything else is idle', () => {
  expect(statusClass('working')).toBe('dot-working');
  expect(statusClass('blocked')).toBe('dot-blocked');
  expect(statusClass('offline')).toBe('dot-offline');
  for (const status of ['idle', 'done', 'unknown', 'ended', 'purged', 'something-new']) expect(statusClass(status)).toBe('dot-idle');
});

test('OP_LABEL has a label for every operation the server knows', () => {
  for (const op of Object.keys(OP_SCHEMAS)) {
    expect(typeof OP_LABEL[op], op).toBe('string');
    expect(OP_LABEL[op].length, op).toBeGreaterThan(0);
  }
});

test('OP_LABEL uses the agreed names', () => {
  expect(OP_LABEL).toMatchObject({
    create_project: '新建项目',
    update_project: '修改项目',
    transition_stage: '改阶段',
    upsert_milestone: '编辑里程碑',
    upsert_todo: '编辑 todo',
    mark_checked: '核对条目',
    record_decision: '记录决策',
    set_blocker: '设置阻塞',
    clear_blocker: '解除阻塞',
    link_session: '关联 session',
    unlink_session: '取消关联',
    ignore_session: '不追踪 session',
    unlock_field: '解锁字段',
    revert_event: '撤销',
  });
});

test('opLabel falls back to the operation name', () => {
  expect(opLabel('transition_stage')).toBe('改阶段');
  expect(opLabel('some_future_op')).toBe('some_future_op');
  // Inherited object keys are not labels.
  expect(opLabel('constructor')).toBe('constructor');
  expect(opLabel('toString')).toBe('toString');
});

test('actorLabel: the user, the curator, any other AI', () => {
  expect(actorLabel('user')).toBe('你');
  expect(actorLabel('ai:curator')).toBe('整理员');
  expect(actorLabel('ai:claude-12')).toBe('AI（claude-12）');
  expect(actorLabel('ai:')).toBe('AI');
  expect(actorLabel('system')).toBe('系统');
});

const NOW = new Date('2026-10-30T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');

test('relTime: under a minute is 刚刚, with 59 s and 60 s on either side of the edge', () => {
  expect(relTime(ago(0), NOW)).toBe('刚刚');
  expect(relTime(ago(59), NOW)).toBe('刚刚');
  expect(relTime(ago(60), NOW)).toBe('1 分钟前');
});

test('relTime: minutes up to the hour', () => {
  expect(relTime(ago(5 * 60), NOW)).toBe('5 分钟前');
  expect(relTime(ago(59 * 60 + 59), NOW)).toBe('59 分钟前');
  expect(relTime(ago(60 * 60), NOW)).toBe('1 小时前');
});

test('relTime: hours up to the day', () => {
  expect(relTime(ago(3 * 3600), NOW)).toBe('3 小时前');
  expect(relTime(ago(24 * 3600 - 1), NOW)).toBe('23 小时前');
  expect(relTime(ago(24 * 3600), NOW)).toBe('1 天前');
});

test('relTime: days up to 30, then the date', () => {
  expect(relTime(ago(29 * 86400 + 86399), NOW)).toBe('29 天前');
  const old = new Date(NOW.getTime() - 30 * 86400 * 1000);
  expect(relTime(old.toISOString(), NOW)).toBe(`${pad(old.getMonth() + 1)}/${pad(old.getDate())}`);
});

test('relTime: a time in the future (clock skew) reads as 刚刚, and an unreadable one is shown as it is', () => {
  expect(relTime(ago(-90), NOW)).toBe('刚刚');
  expect(relTime('not a date', NOW)).toBe('not a date');
});

test('shortTime is MM/DD HH:mm in local time', () => {
  expect(shortTime(new Date(2026, 9, 5, 9, 7).toISOString())).toBe('10/05 09:07');
  expect(shortTime(new Date(2026, 11, 31, 23, 59).toISOString())).toBe('12/31 23:59');
  expect(shortTime('not a date')).toBe('not a date');
});

test('shortDate is MM/DD in local time', () => {
  expect(shortDate(new Date(2026, 9, 5, 9, 7).toISOString())).toBe('10/05');
  expect(shortDate(new Date(2026, 11, 31, 23, 59).toISOString())).toBe('12/31');
  expect(shortDate('not a date')).toBe('not a date');
});

const option = (over: Partial<QuestionOptionView>): QuestionOptionView => ({ label: 'x', has_op: true, op: 'transition_stage', args: {}, ...over });

test('describeOption: an option without an operation does nothing', () => {
  expect(describeOption({ label: '拒绝', has_op: false, op: null, args: null })).toBe('不做任何操作');
});

test('Stage choices name the actual project and its destination in Chinese.', () => {
  const names = entityNames(new Map([['p_1', '发布验收']]));
  expect(describeOption(option({ args: { project: 'p_1', stage: 'verify' } }), names)).toBe('把「发布验收」的阶段改为验证');
  expect(describeOption(option({ op: 'clear_blocker', args: {} }))).toBe('解除阻塞');
});

test('Todo choices describe the status, priority and milestone by name.', () => {
  const names = new Map([['todos:t_1', '复核'], ['milestones:m_1', '发布']]);
  const description = describeOption(option({ op: 'upsert_todo', args: { id: 't_1', status: 'done', priority: 'P1', milestone_id: 'm_1' } }), names);
  expect(description).toContain('「复核」');
  expect(description).toContain('完成');
  expect(description).toContain('P1');
  expect(description).toContain('「发布」');
  expect(description).not.toMatch(/t_1|m_1|=/);
});

test.each([
  [option({ op: 'ignore_session', args: { session: 'session-key', ignored: false } }), '恢复跟踪「验收会话」'],
  [option({ op: 'upsert_milestone', args: { position: 3 } }), '添加里程碑，排序设为「3」'],
  [option({ op: 'upsert_todo', args: { milestone_id: null } }), '添加待办，无所属里程碑'],
  [option({ op: 'update_project', args: { project: 'p_1', fields: { priority: null, title: '交付清单' } } }), '修改「交付验收」，优先级设为未定，标题设为「交付清单」'],
] as const)('Structured arguments describe their effect in words: %j', (choice, expected) => {
  const names = entityNames([['p_1', '交付验收']], undefined, [{ key: 'session-key', title: '验收会话' }]);
  expect(describeOption(choice, names)).toBe(expected);
});

test('Option text clips long values without splitting characters.', () => {
  const forty = '😀'.repeat(40);
  expect(describeOption(option({ op: 'record_decision', args: { text: forty } }))).toBe('记录决策「' + forty + '」');
  expect(describeOption(option({ op: 'record_decision', args: { text: forty + '尾' } }))).toBe('记录决策「' + forty + '…」');
});

test('Text choices tell the reader which field their answer supplies.', () => {
  expect(describeOption(option({ op: 'record_decision', args: { project: 'p_1' }, text_arg: 'text' }))).toContain('用你的回答填写内容');
  expect(describeOption(option({ op: 'update_project', args: {}, text_arg: 'fields.title' }))).toContain('用你的回答填写标题');
});

test('Missing arguments and older unknown operations have readable fallbacks.', () => {
  expect(describeOption({ label: 'x', has_op: true, op: 'revert_event', args: null })).toBe('撤销变更');
  expect(describeOption({ label: 'x', has_op: true, op: 'future_op' as never, args: { a: 'b' } })).toBe('未识别的操作');
});

test('Timeline entities show current names and distinguish a deleted blocker.', () => {
  const project = { id: 'p_1', title: '交付验收', blockers: [{ id: 'b_1', text: '等待审批' }], milestones: [], todos: [], decisions: [], contributions: [] };
  expect(entityLabel('blockers:b_1', entityNames([], project))).toBe('等待审批');
  expect(entityLabel('blockers:b_1', new Map())).toBe('已删除的阻塞');
});

test('The board names the human and AI actors.', () => {
  expect(actorLabel('user')).toBe('你');
  expect(actorLabel('ai:curator')).toBe('整理员');
  expect(actorLabel('ai:decider')).toBe('决策员');
});

test('Board times use local calendar boundaries for today, this year and earlier years.', () => {
  const now = new Date(2026, 10, 26, 13);
  expect(localTime(new Date(2026, 10, 26, 9, 5).toISOString(), now)).toBe('09:05');
  expect(localTime(new Date(2026, 2, 3, 23, 55).toISOString(), now)).toBe('03/03 23:55');
  expect(localTime(new Date(2025, 11, 31, 23, 55).toISOString(), now)).toBe('2025/12/31 23:55');
  expect(preciseTime(new Date(2026, 10, 26, 9, 5, 3, 42).toISOString())).toMatch(/^2026\/11\/26 09:05:03\.042 UTC[+-]\d\d:\d\d$/);
  expect(localTime('2026-03-03', now)).toBe('03/03');
});

test('middleEllipsis leaves short text alone and cuts a long one in the middle, keeping the end', () => {
  expect(middleEllipsis('/srv/app', 20)).toBe('/srv/app');
  expect(middleEllipsis('a'.repeat(20), 20)).toBe('a'.repeat(20));
  const cut = middleEllipsis('/Users/eason/Documents/nasa718/agent-pm-web', 24);
  expect(Array.from(cut)).toHaveLength(24);
  expect(cut.startsWith('/Users/')).toBe(true);
  expect(cut.endsWith('agent-pm-web')).toBe(true);
  expect(cut).toContain('…');
});

test('middleEllipsis counts characters, so an emoji or Chinese is not cut in half', () => {
  const cut = middleEllipsis('/项目/😀😀😀😀😀😀😀😀😀😀/最后一层目录', 10);
  expect(Array.from(cut)).toHaveLength(10);
  expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});
