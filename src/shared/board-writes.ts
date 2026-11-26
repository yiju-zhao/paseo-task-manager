import { z } from 'zod';

export const QuestionAnswer = z.union([z.strictObject({ option_index: z.number() }), z.strictObject({ text: z.string() })]);
export const ReminderSnooze = z.strictObject({ key: z.string().min(1).max(2000), hours: z.int().min(1).max(24 * 90).nullable() });
export const MergeSelection = z.strictObject({ target: z.string().min(1), sessions: z.array(z.string().min(1)).max(500).optional() });
export const MergeApproval = z.strictObject({ overwrite_locked: z.array(z.string()).optional() });
