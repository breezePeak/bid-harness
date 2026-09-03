# Agent Note: S4 按章节身份保留资料，以缺口降级普通映射失败

Status: implemented

## Problem

逐可写叶子创建 Child 会重复检索同一业务分支。Section 检索指纹把标题或写作提示调整变成强制重做资料映射；事件级 search/read 证明又把可用正文与会话记录完整性绑定。单个 Child 失败中止批次，使无资料或用户编辑目录成为进入章节写作的障碍。

## Decision

S1 → S2 → S3 → S4 → S5 → S6 的阶段和 S1–S3 业务逻辑保持不变。S4 Task 是执行批次，Section 是业务实体。Host 按目录顶层业务分支分组；唯一根目录下的结构分支各成一批，直属叶子合为一批。plan v5 保存 section_ids，Evidence Map v10 只按 section_id 保存材料、缺口和写作维度。

S4 执行一轮映射、一次目录深化及 Evidence reconcile，再等待用户确认。reconcile 保留同 ID Evidence，新增章节建立空材料和 missing_topics，删除章节移除映射。可写章节拆成子章节时，继承最近祖先的原资料并提示 S5 重新筛选和补充；没有保留祖先 ID 的新节点按新增章节处理。最终用户编辑执行同一确定性操作，不启动 Mapping Child。最终集合检查只要求可写章节全部存在且无未知或重复 ID。

本地证据保留文件身份、reference/reference_bid 角色、分块存在与文件归属、路径安全和 usage 权限校验，不检查 Child read 日志。Agent 仍须先定位并阅读资料。无资料、无搜索结果、fetch 失败、无效材料和单 Child 异常以对应章节的 missing_topics 降级；模型输出最多在原 Child 修复一次。无效材料被移除，同批其他可解析章节和其他 Task 保留结果。用户取消、Corpus 预检或 Host 持久化及权限机制故障仍可中止阶段。

S4 与 S5 共用 web-evidence-snapshot.ts：捕获当前 Child 的真实 web_fetch 结果，HTTP(S)、成功、HTTP 2xx 和非空正文生成 Snapshot 与正文 SHA-256。URL 和正文哈希生成稳定 source_id；不同正文分别保存，相同正文去重。Web ledger v2 不要求 call ID、事件序号或 search-to-fetch 关联。Agent 的研究步骤仍为 web_search → web_fetch → 阅读正文；搜索摘要和普通模型回答不能生成正式来源。GPT / CPA 支持 action.sources、results、url_citation 和 web_search_result_location 四种结构化来源。

S5 从原有三个 Artifact 读取当前目录和资料，空 Evidence 合法，Writer 可继续自主补搜。企业事实仍只能来自本地资料，缺失事实必须保留 unresolved_topics。Writer、Reviewer、DAG、Workbench 与 framework/reference_bid 的职责不变。

## Alternatives considered

**逐叶 Task 加 Section 指纹强校验。** 原方案使任务计数等于叶子数，并试图证明研究时的语义与写作时一致；代价是目录编辑触发重复研究。资料相关性由 S5 按当前章节重新判断，结构覆盖由 Section ID 检查，不把研究新鲜度作为阶段准入条件。

**强制 search/read 事件证明。** 原方案用于证明材料来自当前 Child 的完整研究链，但事件完整不保证摘要正确。真实 fetch 正文、快照、哈希以及本地文件归属足以确定资料来源，Agent 阅读与选择质量由其任务和 S5 审查承担。

**任一 Task 失败即中止全部任务。** 不采用，普通资料缺失不是项目失败；逐章节缺口能保留已完成的研究并允许写作继续。真正的 Host 文件与权限故障仍显式失败。

**目录变化后补映射。** 不采用，重复 Mapping 使最终确认依赖额外模型执行。确定性 reconcile 允许确认立即推进，资料不足由 S5 在当前章节语义下补充。

## Consequences

旧 Evidence Map v9、plan v4 和 Web ledger v1 不兼容，已有旧格式产物需重新执行 S4。资料快照证明正文来源与持久化完整性，不证明网页事实或摘要语义，也不保证标题调整后的资料仍相关。S5 明确接收空材料和继承材料筛选提示。

本记录部分取代[Host 任务与证据新鲜度](../architecture/2026-09-03-bid-section-evidence-freshness.md)、[同会话修复](../bug-fix/2026-09-02-bid-evidence-mapping-continuation.md)、[并行映射](../feature/2026-08-30-bid-evidence-mapping-agent-stage.md)和[六阶段角色分离](../architecture/2026-09-02-bid-role-separated-evidence-flow.md)的任务粒度、补映射和来源证明决策；这些记录的 Corpus 授权、子代理生命周期、文件角色和六阶段职责依据仍有效，保留并互相链接。

验证覆盖 14 个叶子的分组计划、同批无效材料隔离、单任务异常不取消其他任务、空材料、无事件序号的 fetch 快照、用户目录编辑、拆分继承、S5 补搜和 GPT / CPA 四种来源。真实源码 Loader 回放固定 S4 Child 修复对话与最终 Artifact；S1–S3 和六阶段调度使用现有回归测试。
