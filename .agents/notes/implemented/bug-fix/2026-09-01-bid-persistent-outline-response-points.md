# Agent Note: Bid 持久化目录草稿与稳定评分响应点

Status: implemented

## Problem

S4 的生成质量判断与 S5 的用户确认规则共用同一验证入口，导致合法的用户草稿被生成粒度阈值拒绝。浏览器把长期操作队列和临时章节 ID 当作目录真相，刷新、并发保存和反馈重新生成无法稳定延续用户修改。评分响应点又以可编辑文本作为身份，使 S3、S4、S5 和 S7 无法分别证明每个响应点的覆盖关系。

## Decision

S4 与 S5 只共享目录树和结构化引用覆盖规则。S4 额外执行可写叶子的 Requirement 与 Scoring 数量上限、标题与 `must_answer`、来源模式和质量报告检查；S5 额外执行持久化草稿的 revision、来源哈希、草稿哈希、乐观并发和确认记录一致性检查。S5 不执行 S4 的生成质量规则。

`outline/draft.json` 是 S5 的唯一业务真相。Host 从成功的 `outline/outline.json` 初始化 revision 1；成功改变草稿时 revision 增加，`source_outline_sha256` 始终绑定当前 S4 来源，`draft_outline_sha256` 只哈希 envelope 内的规范 Outline。每次 Mutation、确认和重新生成都同时比较预期 revision 与草稿哈希。浏览器只保留当前 Host View、短暂输入和请求状态，不保存长期操作日志，也不向 Host 发送 `tmp-*` 业务 ID。新增章节由 Host 分配 `SEC-*` 并随新草稿返回。

重新生成以当前持久化草稿为基线。Agent 在 S4 质量规则下产生候选目录、质量报告和声明变更的 change set；Host 对草稿与候选做确定性 diff，只在候选、质量报告和 change set 全部一致时原子替换草稿。失败保留旧草稿、revision 和哈希，Session 继续处于 `outline_confirmation/waiting_user`。确认先校验当前草稿并持久化、复读验证确认 Artifact，最后才记录用户确认和阶段完成事件。

`analysis/scoring-response-points.json` 为每个 S2 评分响应点保存 Host 分配的 `RP-*`、所属评分项、顺序、文本快照、下一分配序号和 `scoring.json` 哈希。修改文本或移动顺序不改变 ID，删除后分配序号不回退。S3 Mapping、S4/S5 Outline 和 S7 覆盖报告使用 ID 判断唯一覆盖，同时保留现有文本对供 S6 使用。

S3 的人工框架和参考旧标书 Mapping 绑定真实 `structure.json` 章节，或绑定从 Chunk 标题路径派生的稳定章节。所有普通、评分响应点、研究主题和特殊资产正文引用进入相同的文件角色、Chunk、行范围和链接路径验证。

## S6 边界

本次不改变 S6 的 Artifact、Executor、Validator、Prompt 或测试。S6 继续使用 Outline 和 Chapter Metadata 中的 `scoring_id + response_point` 文本对；S6 Response Point ID 迁移 deferred。S7 只把这些文本对解析回稳定 ID 并审核结构化声明的缺失、重复和错配，仍明确声明详细正文语义审核未实现。

## Alternatives considered

**S4 和 S5 都取消数量上限。** 这能避免确认阶段误拒绝，但失去 S4 对 Agent 生成 Blueprint 粒度的确定性门禁；数量上限因此只保留在 S4。

**浏览器继续累计 operations 并在确认时一次提交。** 该模型无法跨刷新恢复，也无法用 CAS 阻止陈旧页面覆盖新草稿，并要求维护两套章节 ID，因此不采用。

**用响应点文本哈希作为 ID。** 文本编辑会改变身份，重复文本也无法表达独立评分语义，因此由 Host 使用不复用的递增序号分配 ID。

**把稳定 ID 立即写入 S6 Metadata。** 这会扩大本次范围并升级现有 S6 durable format；当前通过文本对回查 Catalog 保持 S6 不变。

## Consequences

用户目录编辑可跨刷新和重进会话恢复，陈旧请求不能覆盖新 revision，新增节点立即使用正式 ID 继续编辑。S4 的 5 Requirement、4 Scoring 反例失败，而同一目录在 S5 共享规则下通过。独立 Catalog 增加一个必须与 `scoring.json` 同步维护的 durable Artifact；重新生成还增加候选和 change-set 校验成本，但失败不再破坏已保存草稿。
