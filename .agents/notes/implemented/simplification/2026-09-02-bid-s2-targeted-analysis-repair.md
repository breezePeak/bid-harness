# Agent Note: S2 招标分析按校验问题定向修复

Status: implemented

## Problem

S2 在首次提取后无条件执行全量 Coverage Audit，即使四个 Artifact 已通过确定性校验也会重新调用模型并复读招标分块。评分项的逐项全局搜索和不含字段类型的提示词还会放大模型回合，并把局部 Schema 错误变成全阶段复查。

## Decision

`executeTenderAnalysis()` 在首次提取后立即运行 `validateTenderAnalysis()`；成功结果直接等待用户确认。Validator 失败时，Repair 只列出 Issues 指向的 Artifact 和字段，限制模型不读取或修改未指向的 S2 Artifact。来源引用问题带回拥有该引用的 Artifact 和字段路径，使 Repair 可以重读对应 chunk 后修正引用。

评分项提取提示词先用 grep 定位评分区域锚点，再使用 `chunks/index.json` 中的相邻 chunk 关系连续阅读小窗口。评分区域结束后，模型只再执行一次全局 grep 查找远距离技术评分区域。`must_answer` 在首次提取和 Repair 提示词中明确为 boolean，评分响应点继续留在 S3。

Validator 只在 Requirements 或 Scoring 为空时读取完整 tender 语料，以保留异常空结果检测；非空 Artifact 仍逐条校验引用文件、chunk 和行号。

## Alternatives considered

**保留全量 Coverage Audit。** 不采用，因为它在已通过确定性校验的结果上增加完整模型回合，且不能比精确引用校验提供更可靠的来源证明。

**放宽 source_refs 校验。** 不采用，因为局部 Repair 可以保留真实文件、chunk 和行号校验，不需要以降低可追溯性换取速度。

**在 S2 拆解评分响应点。** 不采用，因为 S3 拥有评分语义拆解和稳定响应点 ID。

## Consequences

有效的首次 S2 提取不再产生 Audit 回合。失败修复的模型输入和文件读取范围随 Validator Issues 缩小；空 Requirements 或空 Scoring 仍触发完整性保护。连续评分区域和远距离锚点由模型任务约束，确定性 Validator 继续负责 Artifact 和引用合法性。
