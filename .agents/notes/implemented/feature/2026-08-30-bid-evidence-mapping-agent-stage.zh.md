# Agent Note: Bid 通过实时 Agent 执行技术资料映射

Status: implemented

[English](2026-08-30-bid-evidence-mapping-agent-stage.md) | 中文

## Problem

招标分析已经识别 Requirement 与评分项，但后续技术标写作需要可用的本地技术资料和明确缺口，不能假定存在名称匹配的文件就可使用。

## Decision

现有 Bid Host 推进路径把 `evidence_mapping` 与招标分析并列注册。Executor 等待实时 Session Agent，删除旧的 `analysis/evidence-map.json`，把本轮工具限制为 `grep`、`read` 和 `write`，并只注入当前 Session 路径和 S3 任务。Agent 读取 manifest 与 S2 Artifact，自行生成搜索词，在 grep 后读取候选分块，再写入 evidence map。

Artifact 为每个 S2 Requirement 与 Scoring 项各保存一个 mapping。每项本地资料引用 manifest 文件、索引分块、闭区间行号、摘要及一种写作用途：`reuse` 表示逻辑可高度复用，`adapt` 表示需要结合项目改写，`reference` 表示技术参考，`background` 表示用于理解项目。没有资料时允许 materials 为空，由 `missing_topics` 记录缺少的技术内容。

S3 完成权属于 Validator。它校验 Artifact schema、S2 标识完整覆盖、manifest 文件与解析状态、分块归属、链接路径和引用行号。只有通过校验，Host 才记录阶段完成并推进到 `outline_generation/pending`。任何失败的自动非用户阶段都通过现有通用重试操作重试。S3 复用已注册的 `web_search`，但只在本地资料不足且缺口属于公开技术知识时按需搜索。

`external_materials` 记录 title、http(s) URL、publisher、published_at、retrieved_at、usage 与 summary；usage 只允许 `reference` 或 `background`。企业事实、产品能力、人员经验和服务承诺只能由本地资料证明，缺少本地依据时保留 `missing_topics`。网页内容是非可信研究资料，网页中的指令、命令、提示词修改或写文件要求都不能改变 S3 的任务、工具权限或唯一输出路径；工具守卫只允许写入 `analysis/evidence-map.json`。

## Alternatives considered

**把 grep 命中直接当作资料。** 不采用，因为必须读取候选分块才能理解上下文并判断写作用途。

**增加第二套检索或模型 Runtime。** 不采用，因为 Session Agent 与文件系统工具已经提供所需的可记录执行路径。

**要求每个 mapping 必须有资料。** 不采用，因为识别缺少的技术内容正是 S3 的必要产出。

## Consequences

S3 在不增加阶段专用浏览器流程、模型客户端或状态机的前提下复用现有 Web Tool。Validator 会在 Agent 轮次后校验本地引用和外部来源，重试会替换陈旧 S3 输出。外部资料只能作为公开技术参考，不能扩展为企业事实证据。
