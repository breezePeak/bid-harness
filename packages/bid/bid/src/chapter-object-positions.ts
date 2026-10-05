/** 私有章节工具按本轮冻结对象表选择语义对象，由程序绑定持久身份。 */
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

/** 一个 canonical 身份字段及其模型位置字段。 */
export interface ChapterObjectPositionField {
  readonly canonical: string
  readonly model: string
  readonly ids: readonly string[]
  readonly many?: boolean
}

/**
 * 为当前私有工具建立冻结的位置协议，禁止模型提交 canonical 身份。
 * @param fields 当前轮次各字段使用的实际对象顺序。
 * @returns Schema 投影及参数绑定器。
 */
export function createChapterObjectPositions(fields: readonly ChapterObjectPositionField[]): {
  schema: (schema: Record<string, unknown>) => Record<string, unknown>
  bind: (value: unknown) => unknown
} {
  const canonical = new Map(fields.map(field => [field.canonical, field]))
  const model = new Map(fields.map(field => [field.model, field]))
  const select = (field: ChapterObjectPositionField, value: unknown): string | null => {
    if (value === null) return null
    const position = z.number().int().nonnegative().safeParse(value)
    if (!position.success) throw new ToolArgsError([`${field.model}: 必须选择非负整数位置。`])
    const id = field.ids[position.data]
    if (id === undefined) throw new ToolArgsError([`${field.model}: 未知对象位置 ${position.data}。`])
    return id
  }
  const bind = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(bind)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([name, child]) => {
      if (name === 'writable') throw new ToolArgsError(['writable: 是否可写由程序根据目录子节点派生。'])
      if (name === 'order') throw new ToolArgsError(['order: 请选择 sibling_position，正式顺序由程序生成。'])
      if (name === 'sibling_position') return ['order', chapterPosition(child) + 1]
      const identity = canonical.get(name)
      if (identity !== undefined) throw new ToolArgsError([
        `${name}: 不得填写 ID 或短引用；请使用 ${identity.model} 选择当前对象表中的${identity.many ? '位置数组' : '位置'}，实际身份由程序绑定。`,
      ])
      const field = model.get(name)
      if (field === undefined) return [name, bind(child)]
      if (field.many && !Array.isArray(child)) throw new ToolArgsError([`${field.model}: 必须选择位置数组。`])
      return [field.canonical, Array.isArray(child) && field.many ? child.map(item => select(field, item)) : select(field, child)]
    }))
  }
  const schema = (value: unknown): unknown => {
    if (Array.isArray(value)) return (value as unknown[]).map(schema)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => {
      if (name === 'required' && Array.isArray(child)) {
        return [name, (child as unknown[]).filter(item => item !== 'writable')
          .map(item => item === 'order' ? 'sibling_position' : canonical.get(String(item))?.model ?? item)]
      }
      if (name !== 'properties' || child === null || typeof child !== 'object') return [name, schema(child)]
      return [name, Object.fromEntries(Object.entries(child).filter(([property]) => property !== 'writable').map(([property, input]) => {
        if (property === 'order') return ['sibling_position', { type: 'integer',
          description: '选择同级顺序的位置（从 0 开始），正式顺序由程序生成。' }]
        const field = canonical.get(property)
        if (field === undefined) return [property, schema(input)]
        const description = `选择当前对象表中的${field.many ? '位置数组' : '位置'}，实际身份由程序绑定；不得填写 ID 或短引用。`
        const position = { type: 'integer', description: '选择当前对象表中的位置，实际身份由程序绑定；不得填写 ID 或短引用。' }
        const source = input as Record<string, unknown>
        return [field.model, field.many ? { ...source, description, items: position }
          : source.oneOf !== undefined || source.anyOf !== undefined ? { oneOf: [position, { type: 'null' }], description } : position]
      }))]
    }))
  }
  return { bind, schema: input => schema(input) as Record<string, unknown> }
}

function chapterPosition(value: unknown): number {
  const position = z.number().int().nonnegative().safeParse(value)
  if (!position.success) throw new ToolArgsError(['sibling_position: 必须选择非负整数位置。'])
  return position.data
}
