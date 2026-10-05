/** 模型决定目录树；Host 按树派生可写状态，不补造叶节作答要求或业务归属。 */
import type { OutlineArtifact } from './outline-generation-artifacts.ts'

/**
 * 按实际子节点同步模型目录的可写状态，并清空结构节点的作答要求和响应点。
 * @param outline 已绑定身份的模型目录候选。
 * @returns 保留叶节语义、由 Host 派生可写状态的目录；新叶节仍须通过非空作答要求校验。
 */
export function deriveOutlineModelTree(outline: OutlineArtifact): OutlineArtifact {
  const parents = new Set(outline.sections.map(section => section.parent_id))
  return { ...outline, sections: outline.sections.map(section => parents.has(section.id)
    ? { ...section, writable: false, must_answer: [], scoring_response_point_ids: [], scoring_response_points: [] }
    : { ...section, writable: true }) }
}
