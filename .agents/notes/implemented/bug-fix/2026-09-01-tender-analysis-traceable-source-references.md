# Agent Note: 招标分析引用只证明来源可追溯

Status: implemented

## Problem

S2 的 Requirement、Scoring item 和 Compliance item 需要把冗长招标条款整理为可独立响应的内容。要求 `raw_text` 逐字存在于一个引用范围会拒绝不改变原意的提取、压缩、去冗余和原子化，并把确定性的来源合法性校验错误地扩展为文本推导判断。

## Decision

S2 Validator 只校验 `source_refs` 的来源真实性和引用合法性：`file_id` 必须对应成功解析的 tender 文件，chunk 必须由该文件的索引拥有，行号必须位于 chunk 内，所有路径必须位于 Session Workspace 且通过链接路径检查。Validator 不比较 `raw_text` 与引用正文，也不引入相似度或额外模型判断。

生成、Coverage Audit 和 Repair 提示词允许 Agent 在引用原文含义内提取、压缩、去冗余和原子化 `raw_text`，同时禁止改变关键数字、单位、强制语义或新增要求。Agent 写入前重新读取引用范围并核对来源；归纳和进一步拆解仍分别写入 `normalized_requirement`、`normalized_rule`、`criterion` 或 `response_points`。

## Alternatives considered

**继续要求逐字包含。** 放弃，因为该规则把合理的结构化提取当成错误，造成无法通过引用修复解决的重复失败。

**引入文本相似度阈值。** 放弃，因为阈值不能可靠判断数字、单位和强制语义是否被改变，还会增加不透明的误判。

**增加一次 LLM 语义校验。** 放弃，因为它引入额外成本和非确定性，且不能替代真实文件、chunk、行号和路径的确定性校验。

## Consequences

合理改写不会因字面差异被 Validator 拒绝，S2 仍保留可定位到真实招标文件范围的来源链。关键事实是否忠实由生成、自审和修复提示词约束；Validator 只对可确定证明的引用合法性负责，不声称验证语义忠实度。
