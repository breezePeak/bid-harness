# Agent Note: 招标分析引用只证明来源可追溯

Status: implemented

## Problem

S2 的 Requirement、Scoring item 和 Compliance item 需要把冗长招标条款整理为可独立响应的内容。让模型同时生成语义结论和逐字 quote，会因标点、空白或轻微改写使真实来源被拒绝；让模型生成 `raw_text` 又把可由已定位原文确定的字段留在非确定性输出中。

## Decision

S2 提交工具根据模型提供的 `file_ref`、chunk ID 和 `semantic_hint` 生成原文 quote 与 `source_refs`：`file_id` 必须对应成功解析的 tender 文件，chunk 必须由该文件的索引拥有，所有路径必须位于 Session Workspace 且通过链接路径检查。Host 排除 HTML comment 元数据，规范化正文行和线索，以固定双字符组覆盖下限选择唯一最佳行，再从未规范化的 chunk 原文直接截取 quote、生成三类记录的 `raw_text` 并计算行号。线索不足或最佳行并列时拒绝当前条目；最终 Validator 重新检查真实文件、chunk、路径和行号。

Agent 负责选择 tender 与 chunk、提供语义位置线索，并把归纳分别写入 `normalized_requirement`、`normalized_rule` 或 `criterion`；它不提交 quote、`raw_text`、真实 source/path 或行号。一个 source 定位一行正文，跨行或跨 chunk 内容使用多个 source；评分响应点仍由 S3 生成。

## Alternatives considered

**继续要求模型提交逐字 quote。** 放弃，因为该规则把抄写差异当成来源错误，并要求模型反复修订本可由 Host 截取的字段。

**用相似度判断语义结论是否忠实。** 放弃，因为阈值不能可靠判断数字、单位和强制语义是否被改变。固定双字符组覆盖只用于模型已选 chunk 内的行定位，不替代全量语义复核。

**增加一次 LLM 语义校验。** 放弃，因为它引入额外成本和非确定性，且不能替代真实文件、chunk、行号和路径的确定性校验。

## Consequences

模型的标点、空白和轻微措辞差异不会污染最终 quote；三类 `raw_text` 均由真实 chunk 原文组成，S2 输出的 `source_refs` 结构以及 S3–S5 的读取方式不变。固定行级定位会拒绝线索过短、重合不足或并列的位置；关键事实是否忠实仍由生成与独立全量复核负责，Validator 不声称验证语义忠实度。
