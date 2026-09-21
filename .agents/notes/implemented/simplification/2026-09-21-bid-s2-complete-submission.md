# Agent Note: S2 完整结果单次提交

Status: implemented

## Problem

S2 把一次招标分析拆成项目事实、技术要求、评分项、合规项和 finish 五类工具调用，并让模型维护 create、replace、runtime ref、revision 与独立 review。长招标文件的搜索和 read 内容已经占用较多上下文，逐项结果、staged snapshot 与 repair 历史继续累积，使评分表已经读取但尚未 finish 的运行可能在正式 Artifact 生成前耗尽修复预算。

## Decision

S2 只注册一个 `submit_tender_analysis` 提交工具。模型首次调用时一次提交 `project_facts`、`requirements`、`scoring_items` 和 `compliance_items`，只包含业务内容及实际读取的 `file_ref`、chunk 和 `anchor_text`；Host 立即把该无 ID 结果写入 `analysis/tender-analysis-candidate.json`，再解析来源、生成正式 ID 与排序并统一校验。

Host 只向修复轮次提供当前问题、对应业务项及该项引用的 chunk 原文，不回传完整 candidate。模型仍调用 `submit_tender_analysis`，但只提交 `{repair:{<repair_key>:<业务项>}}`；Host 按内部数组位置合并、覆盖 candidate 文件并重新校验。缺少某类记录时 repair 追加一个业务项。模型不接触数组位置、runtime ref、revision、replace ref、正式 ID 或 source ref。

来源只校验成功 tender、chunk 归属和 `anchor_text` 非空，并以整个 chunk 的行范围生成引用；具体理由见 [S2 chunk 级来源校验](2026-09-21-bid-s2-chunk-source-validation.md)。完整 candidate 通过 Draft Validator 后，Host 生成连续的 `REQ-*`、`SC-*`、`COM-*` ID，归并结构相同的评分大项，原子写入既有四个正式 Artifact 和评分选择，再运行最终 Validator。S3、前端审核和后续阶段只读取既有正式 Artifact。

本记录部分替代 [S2 Host 提交协议](../architecture/2026-09-07-bid-s2-host-owned-submission-protocol.md)中的逐项提交实现，并完整吸收 staged replace 协议曾保护的语义：模型错误不能覆盖其他记录，Host 身份不能由模型猜测，未完成结果不能冒充正式 Artifact。数组位置现由 Host 私有 candidate 持有，因此运行时引用与 checkpoint revision 不再存在。

## Alternatives considered

**保留逐项 staged 协议，只修 finish Prompt。** 不采用；它仍保留五类调用、runtime ref、revision、snapshot 与 review 上下文，不能消除导致问题的状态和调用数量。

**校验失败后让模型重交四个完整数组。** 不采用；完整结果与前序搜索、read 内容会在每个 repair 回合重复进入上下文。

**让 Host 从普通文字回复解析结果。** 不采用；工具 Schema 是业务字段的确定边界，普通文本会重新引入格式修复。

**增加 repair 次数。** 不采用；更多轮次只放大重复上下文，不能修复 finish 与 revision 协议本身。

## Consequences

S2 正常链路没有 `finish_tender_analysis`、create、replace、runtime ref、revision、staged snapshot 或独立 review。失败 repair 只携带一个问题项；评分项进入首次完整提交后由 Host 直接生成正式结构，不会因遗漏 finish 而丢失。

内部 candidate 不是正式 Artifact，S3 和前端不会读取它。S2 进程在正式发布前中断时不恢复逐项 repair 位置；新运行重新提交完整结果并覆盖 candidate。定向测试固定 candidate 先于校验持久化、局部 repair、模型字段拒绝、评分写入、正式连续 ID、chunk 级来源及最终 Validator，无密钥 Loader 回放固定一次完整提交路径。
