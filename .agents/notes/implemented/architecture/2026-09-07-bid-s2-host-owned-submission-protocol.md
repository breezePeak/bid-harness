# Agent Note: S2 由 Host 接管确定性提交协议

Status: implemented

## Problem

S2 Main Agent 直接写四个完整 JSON 时同时承担招标语义判断、正式 ID、文件身份、chunk 归属、行号、文件覆盖和 Schema 组装。后六项都能由 Host 确定，却会因模型抄写错误消耗整文件修复回合；Agent 空闲也不能证明其确实提交了完整结果。

## Decision

`tender_analysis` 继续由同一 live Agent 在当前 Session 和 Workspace 中执行，并保持 tender-only 技术标边界、`grep → read` 检索、评分区域连续读取、最终 Validator 与用户确认。普通工具只开放 `grep` 和 `read`，版式不足时按需使用 `view_pdf_page`；阶段执行器动态注册一个 `submit_tender_analysis`，模型不能调用 `write` 生成正式 Artifact。

Host 按 manifest 顺序把每个 `role=tender && parseStatus=success` 文件映射为 `T1`、`T2` 等执行期引用。提交工具的 source 只接受 `file_ref`、chunk index 中的 `chunk_*` ID 和从已读正文逐字复制的 `anchor_text`；Host 验证文件与 chunk 归属，仅以 NFKC 及连续空白归一化做唯一确定性匹配，再从未规范化的原始正文截取 quote，并按原始 chunk 中换行符计算一基、闭区间 `line_start` 和 `line_end`。锚点未命中或多次命中都返回 recoverable issue 并结束当前 Turn，分别要求重新读取后复制原文或提供更长的原文；跨行或跨 chunk 内容由多个 source 定位。该替换拒绝的语义猜测机制见 [S2 原文锚点定位协议](../bug-fix/2026-09-13-bid-s2-original-text-anchor-protocol.md)。

模型一次提交 `project_facts`、`requirements`、`scoring_items` 和 `compliance_items` 四个完整数组，只提供分类、归纳、强制性、评分规则等语义字段及真实来源。Host 在整批来源和内容通过校验后，按最终数组顺序分配三位补零的 `REQ-*`、`SC-*`、`COM-*` 正式 ID；模型不生成 runtime ref、revision、replace ref 或正式 ID。三类记录的 `raw_text` 都由 Host 连接已定位的原文 quote 生成。Scoring 只接受招标评分体系中作为独立评审对象，并具有独立名称及总分、权重或区块边界的评分大项，Host 固定正式 `parent=null`；重复评分大项按除来源和 ID 外的完整结构化内容归并并合并来源，不能只凭名称合并。

`submit_tender_analysis` 首次接收完整数组后立即持久化内部 candidate，再组装四个现有 Schema：Host 提供 schema version、未知项目单值 `null`、未知数组 `[]`、manifest 中全部成功 tender 的 `analyzed_tender_files`、正式 ID 和 source refs。持久化前复用 Validator 的语料完整性与技术评分分类检查；来源、缺项或结构问题只把当前问题、出错项及其引用的 chunk 原文交给下一轮，模型通过同一个工具提交该项的 `repair`，Host 按内部数组位置合并并重验。通过后 Host 原子写入四个正式路径并立即运行 `validateTenderAnalysis()`；Agent 只回复文字不能推进 S2。批量替代逐项 staged、finish 和 review 的理由见 [S2 完整结果单次提交](../simplification/2026-09-21-bid-s2-complete-submission.md)。

用户确认仍只编辑规范化结论并保留 ID、原文、引用和文件覆盖。S3 继续读取相同路径、扁平数组和 Artifact Schema，并独立负责评分细则的响应点拆解。

## Alternatives considered

**继续让模型写完整 JSON，再按 Validator issue 定向修文件。** 不采用；它缩小了修复范围，却仍把稳定 ID、引用行号、文件覆盖与 Schema 组装交给模型。该历史方案记录于[S2 定向修复决策](../../archived/simplification/2026-09-02-bid-s2-targeted-analysis-repair.md)。

**只加强 Prompt。** 不采用；Prompt 不能使文件身份、原文截取、chunk 归属或正式 ID 成为确定性结果。

**在阶段重置后保留暂存检查点。** 不采用；重置必须清理 S2 与下游状态，旧暂存不能成为新分析的输入。

**让 Host 按关键词生成 Requirement、Scoring 或 Compliance。** 不采用；技术与商务边界、原子化、分类、强制性和规范化表达仍需要招标语义判断。

**把评分响应点一并放入 S2。** 不采用；S3 拥有评分响应点的语义拆解和稳定 `RP-*` 身份。

## Consequences

模型不再维护四个 JSON 文件、逐字 quote、`raw_text`、真实文件 ID、引用路径与行号、评分 parent、正式记录 ID、schema version 或 tender 覆盖。评分项边界仍由模型依据原文层级和语义判断，Host 只固定 `parent=null` 并合并结构完全相同的重复大项，不使用名称、分值或样本位置猜测层级。模型复制的原文锚点只在其已选定的 chunk 内定位，不判断语义是否忠实；S2 每轮只有一次提交调用，最终 Validator 保持为 Host 与持久化回归的独立防线。

Keyless 源码 Loader 回放由固定模型一次提交完整结果，并检查 Host 生成的四个正式 Artifact、稳定 ID、引用行号和最终 Validator 结果。

本记录更新[初始 S2 live-Agent 执行决策](../feature/2026-08-30-bid-tender-analysis-agent-stage.md)和整文件 Repair 的实现机制；引用只证明来源可追溯的语义规则仍由[招标分析引用记录](../bug-fix/2026-09-01-tender-analysis-traceable-source-references.md)约束。
