/** 文档目标、操作与步骤产物选择；位置由 Host 绑定，路径与版本不由模型填写。 */
import { z } from 'zod'
import { promptFileRefSchema } from '@deepseek-ai/dsh-host-apiproxy/api/files'
import { docxBlockRefSchema } from './docx-document-index.ts'
import { bidFigureRefSchema } from './figure-assets.ts'

/** 消费同一 Work 前序步骤的唯一类型化输出。 */
export const bidStepOutputSelectionSchema = z.object({ source: z.literal('step_outputs'),
  step_position: z.number().int().nonnegative(), output_positions: z.array(z.number().int().nonnegative()).length(1),
}).strict()
/** 原稿派生版本的不可变引用，真实来源记录由执行器写入。 */
export const bidDocumentRefSchema = z.object({ kind: z.literal('document'),
  document_id: z.string().regex(/^[a-f0-9]{64}$/u), version: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
/** 原件或本 Work 前序步骤产生的文档。 */
export const bidDocumentSelectionSchema = z.union([
  z.object({ source: z.literal('file'), file_ref: promptFileRefSchema }).strict(), bidStepOutputSelectionSchema,
])
const figureSelection = z.union([
  z.object({ source: z.literal('figure'), figure_ref: bidFigureRefSchema }).strict(), bidStepOutputSelectionSchema,
])
const text = z.string().min(1).max(16000)
const placement = z.enum(['before', 'after'])
/** 已完成候选的节点及它继承的原授权位置，全部由 Host 从真实回执绑定。 */
export const bidCandidateBlockRefSchema = z.object({ document_ref: bidDocumentRefSchema,
  block_ref: docxBlockRefSchema, source_ref: docxBlockRefSchema }).strict()
const anchor = { block_ref: docxBlockRefSchema.optional(), candidate_block_ref: bidCandidateBlockRefSchema.optional() }
/** 模型选择真实文档块；图片可以预先引用尚未执行的前序生图步骤。 */
export const bidDocumentPatchOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('insert_figure'), ...anchor, placement,
    figure: figureSelection, caption: z.string().trim().min(1).max(500).optional()
      .describe('只填写题注内容，不填写“图 2”等前缀或编号；程序按原稿字段序列生成图号。') }).strict(),
  z.object({ type: z.literal('replace_figure'), ...anchor, figure: figureSelection }).strict(),
  z.object({ type: z.literal('replace_block_text'), ...anchor, text }).strict(),
  z.object({ type: z.literal('insert_paragraph'), ...anchor, placement, text }).strict(),
  z.object({ type: z.literal('delete_object'), ...anchor }).strict(),
]).refine(value => (value.block_ref === undefined) !== (value.candidate_block_ref === undefined),
  '必须选择原稿 block_position 或已检查候选 candidate_block_position，且只能选择一种。')
  .describe('目标必须且只能选择 block_position 或 candidate_block_position；分别来自原稿和已完成步骤的候选对象表。')
/** 原稿精确补丁输入；删除必须属于真实用户已授权目标。 */
export const bidDocumentPatchInputSchema = z.object({ document: bidDocumentSelectionSchema,
  operations: z.array(bidDocumentPatchOperationSchema).min(1).max(100),
}).strict()
/** 页面检查默认只读，修复只作用于任务已授权的局部对象。 */
export const bidDocumentLayoutInputSchema = z.object({ document: bidDocumentSelectionSchema,
  mode: z.enum(['inspect', 'repair']), reason: z.string().trim().min(1).max(4000),
}).strict()
/** 真实文档版本身份。 */
export type BidDocumentRef = z.infer<typeof bidDocumentRefSchema>
/** 同一任务中后续步骤选择的产物位置。 */
export type BidStepOutputSelection = z.infer<typeof bidStepOutputSelectionSchema>
