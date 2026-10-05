/** 将程序目录 fixture 的父位置投影为模型语义树，不调用生产绑定器。 */

/**
 * 按 fixture 中的父关系嵌套节点，模型回复不包含本轮父位置。
 * @param sections 已通过本次请求位置表编译的平面 fixture 节点。
 * @returns 只含根节点和递归 children 的模型候选节点。
 */
export function nestedModelSections(
  sections: readonly (Record<string, unknown> & { parent_position: number | null })[],
): Record<string, unknown>[] {
  let nested = 0
  const children = (parent: number | null): Record<string, unknown>[] => sections.flatMap((section, index) => {
    if (section.parent_position !== parent) return []
    nested++
    const { parent_position: _parent, ...semantic } = section
    return [{ ...semantic, children: children(index) }]
  })
  const roots = children(null)
  if (nested !== sections.length) throw new Error('目录 fixture 不能丢弃没有合法根路径的节点。')
  return roots
}
