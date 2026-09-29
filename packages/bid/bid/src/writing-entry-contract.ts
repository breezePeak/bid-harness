import { z } from 'zod'

/**
 * 写作入口停止记录的项目内路径。
 */
export const WRITING_ENTRY_STOP_PATH = 'chapters/writing-entry-stop.json'

/**
 * 写作入口停止原因的磁盘结构。
 */
export const writingEntryStopSchema = z.object({
  stop_id: z.string().min(1),
  confirmed_outline_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  request_id: z.string().min(1).nullable(),
  attempt_id: z.string().min(1).nullable(),
  plan_version: z.number().int().positive().nullable(),
}).strict()

/**
 * 已校验的写作入口停止记录。
 */
export type WritingEntryStop = z.infer<typeof writingEntryStopSchema>
/**
 * 写作入口期望状态的磁盘结构。
 */
export const writingEntryExpectedSchema = z.object({
  project_revision: z.number().int().nonnegative(),
  request_id: z.string().min(1).nullable(),
  attempt_id: z.string().min(1).nullable(),
  stop_id: z.string().min(1).nullable(),
  plan_version: z.number().int().positive().nullable(),
}).strict()

/**
 * 写作入口检查的期望状态。
 */
export type WritingEntryExpected = z.infer<typeof writingEntryExpectedSchema>

/**
 * 写作入口意图的磁盘结构。
 */
export const writingEntryIntentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ensure') }).strict(),
  z.object({
    mode: z.literal('reopen'),
    expected: writingEntryExpectedSchema,
  }).strict(),
  z.object({
    mode: z.literal('resume'),
    expected: writingEntryExpectedSchema,
  }).strict(),
  z.object({
    mode: z.literal('takeover'),
    expected: writingEntryExpectedSchema,
  }).strict(),
  z.object({
    mode: z.literal('retry_answer'),
    expected: writingEntryExpectedSchema,
  }).strict(),
])

/**
 * 持久化的写作入口意图。
 */
export type WritingEntryIntent = z.infer<typeof writingEntryIntentSchema>

/**
 * 写作入口失败的错误码。
 */
export type WritingEntryErrorCode =
  | 'BID_WRITING_ENTRY_CONFLICT'
  | 'BID_WRITING_ENTRY_ACTION_NOT_ALLOWED'
/**
 * 会话中写作入口投影的键。
 */
export const BID_WRITING_ENTRY_PROJECTION_KEY = 'bid.writing_entry'

/**
 * 写作入口展示状态的磁盘结构。
 */
export const writingEntryViewSchema = z.object({
  expected: writingEntryExpectedSchema,
  phase: z.enum([
    'empty', 'awaiting_answer', 'dismissed', 'planning',
    'failed', 'paused', 'ready', 'running', 'inactive',
  ]),
  owner_session_id: z.string().nullable(),
  request_state: z.enum(['awaiting_answer', 'answered', 'consumed', 'dismissed']).nullable(),
  continuation: z.enum(['allowed', 'paused']).nullable(),
  processing_state: z.enum(['queued', 'running', 'failed']).nullable(),
  has_answer: z.boolean(),
  has_plan: z.boolean(),
  answer_save_status: z.enum(['saved', 'unconfirmed', 'none']),
  can_retry_answer: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
  durability: z.enum(['durable', 'memory_only']),
}).strict()

/**
 * 已校验的写作入口展示状态。
 */
export type WritingEntryView = z.infer<typeof writingEntryViewSchema>
