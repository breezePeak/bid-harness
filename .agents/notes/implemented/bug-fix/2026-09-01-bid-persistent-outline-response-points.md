# Agent Note: Bid 持久化目录草稿与稳定评分响应点

Status: implemented

## Problem

S4 的生成质量判断与 S5 的用户确认规则共用同一验证入口，导致合法的用户草稿被生成粒度阈值拒绝。浏览器把长期操作队列和临时章节 ID 当作目录真相，刷新、并发保存和反馈重新生成无法稳定延续用户修改。评分响应点又以可编辑文本作为身份，使 S3、S4、S5 和 S7 无法分别证明每个响应点的覆盖关系。

## Decision

S4 与 S5 只共享目录树和结构化引用覆盖规则。S4 额外要求 Agent 完成语义粒度复核，并确定性校验质量报告的 Requirement、Scoring、Response Point 和 Section 集合；固定数量、标题关键词和资料来源不作为 Host 硬门槛。S5 额外执行持久化草稿的 revision、来源哈希、草稿哈希、乐观并发和确认记录一致性检查，不读取 S3 Evidence。

`outline/draft.json` 是 S5 的唯一业务真相。Host 从成功的 `outline/outline.json` 初始化 revision 1；成功改变草稿时 revision 增加，`source_outline_sha256` 始终绑定当前 S4 来源，`draft_outline_sha256` 只哈希 envelope 内的规范 Outline。每次 Mutation、确认和重新生成都同时比较预期 revision 与草稿哈希。浏览器只保留当前 Host View、短暂输入和请求状态，不保存长期操作日志，也不向 Host 发送 `tmp-*` 业务 ID。新增章节由 Host 分配 `SEC-*` 并随新草稿返回。

重新生成以当前持久化草稿为基线。Agent 在 S4 质量复核下产生候选目录、质量报告和声明变更的 change set；Host 对草稿与候选做确定性 diff，只在候选、质量报告和 change set 全部一致时原子替换草稿。失败保留旧草稿、revision 和哈希，Session 继续处于 `outline_confirmation/waiting_user`。确认先校验当前草稿并持久化、复读验证确认 Artifact，最后才记录用户确认和阶段完成事件。

`analysis/scoring-response-points.json` 为每个 S2 评分响应点保存 Host 分配的 `RP-*`、所属评分项、顺序、文本快照、下一分配序号和 `scoring.json` 哈希。修改文本或移动顺序不改变 ID，删除后分配序号不回退。S3 Mapping、S4/S5 Outline 和 S7 覆盖报告使用 ID 判断唯一覆盖，同时保留现有文本对供 S6 使用。

S4 直接从 manifest 读取人工框架的 `structure.json`，或从 Chunk 标题路径派生目录骨架；框架不进入 S3 Evidence。S3 的普通资料、旧标书和 Web Snapshot 只影响目录深度与写作指引。

## S6 边界

S6 使用 Outline 和 Chapter Metadata 中的稳定 Response Point ID 与文本快照。S7 审核结构化声明的缺失、重复和错配，仍明确声明详细正文语义审核未实现。

## Alternatives considered

**S4 保留每章固定 ID 数量上限。** 不采用，因为数量不能判断多个 ID 是否属于同一技术主题；S4 的强制质量复核判断语义粒度，Host 只验证确定性关系。

**浏览器继续累计 operations 并在确认时一次提交。** 该模型无法跨刷新恢复，也无法用 CAS 阻止陈旧页面覆盖新草稿，并要求维护两套章节 ID，因此不采用。

**用响应点文本哈希作为 ID。** 文本编辑会改变身份，重复文本也无法表达独立评分语义，因此由 Host 使用不复用的递增序号分配 ID。

**只保存 Response Point 文本。** 不采用，因为文本编辑和重复文本不能稳定表达跨 S3–S7 的唯一归属；Metadata 同时保存稳定 ID 与文本快照。

## Consequences

用户目录编辑可跨刷新和重进会话恢复，陈旧请求不能覆盖新 revision，新增节点立即使用正式 ID 继续编辑。任意数量的合法 Requirement 与 Scoring 关联都可通过 S4/S5 的确定性规则；语义上过粗的章节由 S4 Quality Review 修正。独立 Catalog 增加一个必须与 `scoring.json` 同步维护的 durable Artifact；重新生成还增加候选和 change-set 校验成本，但失败不破坏已保存草稿。
