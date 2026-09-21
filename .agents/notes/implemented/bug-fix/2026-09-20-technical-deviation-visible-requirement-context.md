# Agent Note: 技术偏离表的只读 Requirement 上下文

Status: implemented

## Problem

固定技术偏离表不承担 Requirement 正文 coverage，因此 `section.requirement_ids` 必须为空；S4 和 S5 原先也用该字段筛选模型上下文，导致模型看不到生成逐条响应索引所需的 S2 Requirements。S4 Research 校验同时按全项目 Requirement 放行引用，使 Prompt 可见范围、研究引用范围和 Blueprint 可写范围互相矛盾。

## Decision

`section.requirement_ids` 仍是 Outline coverage ownership 的唯一来源。`sectionVisibleRequirements()` 只计算模型可见的只读 Requirement：普通章节按 `section.requirement_ids` 筛选，固定 `TECHNICAL_DEVIATION_SECTION_ID` 读取保持原顺序的完整 S2 Requirements；该结果不写回目录、Evidence Map、Checkpoint 或 S5 Manifest。

S4 由同一个 Host helper 生成 Prompt 中的 Requirement、Scoring、Response Point 与 Compliance 上下文，并限制 Research Finding 只能引用实际下发的业务记录。独立的 assigned coverage helper 同时驱动 `update_section_task` 的写入校验和 Prompt 所示 `current_coverage_ownership`。空 Requirement ownership 只允许 `section_responsibility` 与 `requirement_ids=[]`；Tool description、参数错误和 Repair 清单直接给出允许集合。

S5 使用 `sectionVisibleRequirements()` 生成 Writer 与 Reviewer 的章节上下文。Writer 候选与最终磁盘正文都通过同一 Markdown AST 解析器验证唯一六列表格、S2 行数和顺序、必要单元格、具体响应及内部编号；技术偏离表按完整 S2 Requirements 逐项形成响应索引，章节对象和 Manifest 继续保存空 `requirement_ids`。

## Alternatives considered

**把全部 Requirement 写入技术偏离表的 `requirement_ids`。** 不采用，因为索引章节会被误算为已经承担正文 coverage，并掩盖后续实质章节的漏项。

**从 `must_answer`、标题或 Requirement category 推断范围。** 不采用，因为这些模型文本与分类不是稳定身份；固定 Section ID 和正式 S2 Artifact 已提供确定性输入。

**只加强 Prompt 或增加重试。** 不采用，因为 Research 校验与 coverage 写入校验仍会接受不同集合，模型无法从重试次数得到唯一合法参数。

## Consequences

技术偏离表在 S4 和 S5 可读取全部 S2 Requirements，但不能把它们写入 Blueprint coverage override 或 Manifest。空表、示例行、缺行、错序和只有状态词的响应在章节保存前失败，最终 Validator 对持久化正文重复校验。普通章节的 Requirement 可见范围保持不变，且越界 Research 引用在工具调用时立即失败。Outline、Evidence Map、Checkpoint 和 Session 格式不变。

定向测试固定共用筛选函数、技术偏离表 Prompt 的全量只读上下文与空 ownership、普通章节越界引用拒绝、空 ownership Blueprint 的完整 S4 收口，以及 S5 Writer 上下文和特殊写作规则。
