# Agent Note: Bid 通过实时 Agent 执行招标分析

Status: implemented

[English](2026-08-30-bid-tender-analysis-agent-stage.md) | 中文

## Problem

Bid 文件接入已经生成持久语料库，但招标分析没有生产执行路径。由浏览器或第二个临时模型客户端推进阶段会绕过 Session Agent；不检查引用便接受模型生成的 JSON，则会让后续阶段依赖没有招标文件依据的事实。

## Decision

Bid Host 在文件接入成功后只启动一个自动阶段。对于 `tender_analysis`，Host 解析实时 Session Agent，等待已有工作静止，删除该阶段负责的四个输出文件，把本轮工具限制为 `grep`、`read` 和 `write`，注入动态 follow-up，再等待 Agent 回到 idle。任务文本包含 Session 工作区、四个严格 JSON schema、只以招标文件为权限来源的规则以及规定停止点。Preset 文本保持稳定；Session 路径和当前阶段数据只进入动态任务。S1 完成后发生的 S2 失败作为成功的 `uploadFiles` Remote 响应返回真实 `tender_analysis/failed` RuntimeState，不得归类为文件接入失败。

Agent 写入 `analysis/project.json`、`analysis/requirements.json`、`analysis/scoring.json` 和 `analysis/compliance.json`。每个提取事实都引用 manifest 文件标识符、已索引分块路径和闭区间行号。`project.json` 还声明分析覆盖的全部成功解析招标文件。

完成判定属于 Validator，而不是 Agent idle。Validator 拒绝缺失或多余 Artifact、无效 JSON 或 schema 字段、重复条目标识符、招标文件覆盖不完整、指向非招标文件或解析失败文件的引用、未知分块路径、链接路径、超出分块范围的行号，以及无法在引用行文本中匹配的 `raw_text`。文本匹配只统一换行和连续空白，不使用 LLM，也不允许结构化摘要代替招标原文。只有通过校验的输出才记录 `bid.stage.completed`；失败记录 `bid.stage.failed`。

`tender_analysis/failed` Projection 只开放 `retry_stage`。Client 只向 `bid/retryStage` Remote 提交重试意图；Host 重新读取 Session 日志并执行准入，复用当前 Agent、工作区、Executor 和 Validator。重试会再次删除四个 S2 Artifact，并向同一 Agent 的文件观测策略记录这些路径不存在，使 `write` 能在读后写保护下重新创建文件。Orchestrator 只执行 `tender_analysis` 一次，成功后停在 `evidence_mapping/pending`，失败则留在 `tender_analysis/failed`，两种结果都不会启动 S3。

## Alternatives considered

**把 `whenIdle()` 当作阶段完成。** 不采用，因为 idle Agent 仍可能遗漏输出、生成无效格式或写入没有依据的内容。

**新增 Bid 专用搜索工具。** 不采用，因为现有文件系统 `grep`、`read` 和 `write` 工具已经能够读取语料库，同时保留正常 Agent Loop 和工具日志。

**上传后运行全部剩余自动阶段。** 不采用，因为 S3 及后续阶段尚无生产 Executor 和 Validator；因此 Host 桥接每次显式调用只推进一个自动阶段。

**重试时保留既有 S2 输出。** 不采用，因为不完整重试可能借用上次遗留文件通过校验。

## Consequences

S2 与普通 Harness 工作共用 Agent Loop、工具注册表、Session 日志和工作区，同时由确定性校验保留工作流状态权限。Validator 会在 Agent 轮次后读取引用行并校验原文，每次重试都会替换全部四个 S2 Artifact。当前 `uploadFiles` 请求会持续到 S2 Agent 与 Validator 完成；在后续长阶段接入前，需要单独决定后台执行方式，本实现不引入任务队列或第二套状态机。S3 仍不可用。
