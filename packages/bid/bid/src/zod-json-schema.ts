import { z } from 'zod'

/**
 * 将 Zod Schema 投影为工具边界接受的纯 JSON Draft 7 结构。
 * @param value 待投影的 Zod Schema。
 * @returns 不含 Zod 运行时 Standard Schema 元数据的普通 JSON Schema。
 */
export function zodJsonSchema(value: z.ZodType, params: z.core.ToJSONSchemaParams = {}): Record<string, unknown> {
  const schema: Record<string, unknown> = { ...z.toJSONSchema(value, { target: 'draft-7', ...params }) }
  delete schema['~standard']
  return schema
}
