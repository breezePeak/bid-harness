/** 客户可见文本检查所需的系统身份及招标原文。 */
export interface BidCustomerTextContext {
  outline: { sections: ReadonlyArray<{ id: string }> }
  requirements: { requirements: ReadonlyArray<{ id: string; raw_text: string }> }
  scoring: { scoring_items: ReadonlyArray<{ id: string; raw_text: string }> }
  compliance: { compliance_items: ReadonlyArray<{ id: string; raw_text: string }> }
  responsePoints: { points: ReadonlyArray<{ id: string }> }
  acceptanceCriterionIds?: readonly string[]
}

function standalone(text: string, identity: string): boolean {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, 'u').test(text)
}

/**
 * 查找泄漏到客户可见文本的项目内部身份；招标原文中的同名编号仍视为采购方编号。
 * @param text 标题、总述、章节正文或已组合文档。
 * @param context 当前项目的权威身份及招标原文。
 * @returns 按项目顺序去重的泄漏身份。
 */
export function findBidInternalIdentifiers(text: string, context: BidCustomerTextContext): string[] {
  const identities = [...new Set([
    ...context.requirements.requirements.map(item => item.id),
    ...context.scoring.scoring_items.map(item => item.id),
    ...context.compliance.compliance_items.map(item => item.id),
    ...context.responsePoints.points.map(item => item.id),
    ...context.outline.sections.map(item => item.id),
    ...context.acceptanceCriterionIds ?? [],
  ])]
  const tenderText = [
    ...context.requirements.requirements.map(item => item.raw_text),
    ...context.scoring.scoring_items.map(item => item.raw_text),
    ...context.compliance.compliance_items.map(item => item.raw_text),
  ]
  return identities.filter(identity => standalone(text, identity)
    && !tenderText.some(source => standalone(source, identity)))
}

/**
 * 按导出顺序返回目录中的客户可见字段。
 * @param outline 当前目录标题、章节标题及总述。
 * @returns 带 Artifact 字段路径的客户可见文本。
 */
export function customerFacingOutlineText(outline: {
  document_title: string
  sections: ReadonlyArray<{ title: string; summary?: string | undefined }>
}): Array<{
  text: string
  path: string
}> {
  return [
    { text: outline.document_title, path: 'document_title' },
    ...outline.sections.flatMap((section, index) => [
      { text: section.title, path: `sections.${index}.title` },
      ...(section.summary === undefined ? [] : [{ text: section.summary, path: `sections.${index}.summary` }]),
    ]),
  ]
}
