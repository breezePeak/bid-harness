# Agent Note: Bid 通过实时 Agent 执行招标分析

Status: implemented

[English](2026-08-30-bid-tender-analysis-agent-stage.md) | 中文

## Problem

Bid 文件接入已经生成持久语料库，但招标分析没有生产执行路径。由浏览器或第二个临时模型客户端推进阶段会绕过 Session Agent；不检查引用便接受模型生成的 JSON，则会让后续阶段依赖没有招标文件依据的事实。

## Decision

文件接入成功后以及每次触发 `agent/session-start` 时，Bid Host 都调用同一个 `BidOrchestrator.drive()`。该循环从 Session 日志归约当前阶段，读取对应 `StagePolicy`，并且只在生产 Executor 返回 `canExecute(stage)` 时执行。`tender_analysis` Policy 声明自动校验后必须取得用户确认；有效草稿记录 `bid.user_confirmation.required` 并停在 `tender_analysis/waiting_user`，不会完成 S2 或启动 S3。

对于 `tender_analysis`，Host 解析实时 Session Agent，等待已有工作静止，删除该阶段负责的四个输出文件，把本轮工具限制为 `grep`、`read` 和 `write`，注入动态 follow-up，再等待 Agent 回到 idle。任务文本包含 Session 工作区、四个严格 JSON schema、只以招标文件为权限来源的规则以及规定停止点。Preset 文本保持稳定；Session 路径和当前阶段数据只进入动态任务。S1 完成后发生的 S2 失败作为成功的 `uploadFiles` Remote 响应返回真实 `tender_analysis/failed` RuntimeState，不得归类为文件接入失败。

Agent 写入 `analysis/project.json`、`analysis/requirements.json`、`analysis/scoring.json` 和 `analysis/compliance.json`。Project 分析包含项目背景、建设目标、实施约束和本项目技术重点；Scoring 只保留技术评分，每项以非空 `response_points` 表达技术标应覆盖的重点内容。每个提取事实都引用 manifest 文件标识符、已索引分块路径和闭区间行号。

Validator 而不是 Agent idle 决定草稿能否进入确认。Host Remote 只返回 Project 和 Scoring，只接受对分析结论的受控编辑，并保留 ID、招标原文、分值、引用与文件覆盖集合。Host 原子替换正式 Project 与 Scoring 路径，再次校验完整 S2 Artifact；只有成功后才记录用户确认与阶段完成。无效用户输入返回问题并保持 `waiting_user`。

`tender_analysis/failed` Projection 只开放 `retry_stage`。Client 只向 `bid/retryStage` Remote 提交重试意图；Host 重新读取 Session 日志并执行准入，复用当前 Agent、工作区、Executor 和 Validator。重试会再次删除四个 S2 Artifact，并向同一 Agent 的文件观测策略记录这些路径不存在，使 `write` 能在读后写保护下重新创建文件。S2 重试成功后由同一驱动器继续后续自动阶段；失败则保持 `tender_analysis/failed`，不会启动 S3。

首次提取完成后，Host 在同一轮工具限制内向同一 live Agent 注入一次 Coverage Audit follow-up，并在第二次 idle 后再验证四个 Artifact。审计根据当前招标文件动态重查技术要求、技术评分、技术否决和必须响应项，发现遗漏时直接修正既有 Artifact。

Validator 还读取成功解析 tender 的分块文本：实质文本下 Requirements、Scoring 和 Compliance 同时为空会失败；技术评分、评审或评价信号对应空 Scoring 会失败；多个技术约束信号对应空 Requirements 会失败。商业评分不触发技术评分保护，任何单个数组仍可在招标文件确实缺少该类内容时为空。

## Alternatives considered

**把 `whenIdle()` 当作阶段完成。** 不采用，因为 idle Agent 仍可能遗漏输出、生成无效格式或写入没有依据的内容。

**新增 Bid 专用搜索工具。** 不采用，因为现有文件系统 `grep`、`read` 和 `write` 工具已经能够读取语料库，同时保留正常 Agent Loop 和工具日志。

**在每个 Host 入口按阶段名分派。** 不采用，因为每增加一个 Executor，上传和 Session 恢复都要各加一个分支。`StagePolicy`、`canExecute()` 和日志归约出的 RuntimeState 已经能够完整决定是否继续。

**重试时保留既有 S2 输出。** 不采用，因为不完整重试可能借用上次遗留文件通过校验。

**允许浏览器上传替换后的完整 JSON。** 不采用，因为这会允许浏览器绕过 Host 伪造原文、分值、引用与文件覆盖。

## Consequences

S2 与普通 Harness 工作共用 Agent Loop、工具注册表、Session 日志和工作区，同时由确定性校验与显式用户确认保留工作流状态权限。用户编辑覆盖既有正式 Artifact 路径，不产生并行的 final 文件；浏览器只保存未提交草稿并可在校验失败后继续修改。S3 在确认后的完整 Artifact 通过校验前不能执行。
