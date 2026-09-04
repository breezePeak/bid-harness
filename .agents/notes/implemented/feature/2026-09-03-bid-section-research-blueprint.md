# Agent Note: S4 完成章节研究与写作任务，S5 按 Blueprint 局部补检索

Status: implemented

## Problem

只按 Section ID 对齐资料无法处理同 ID 的写作语义变化，拆分继承也不能证明原材料适合新章节。引用或抓取错误混入 missing_topics 会制造业务缺口；S5 被迫重新判断章节目标并重复资料研究。用户连续编辑目录时立即重做研究又会妨碍正常修改。

## Decision

S4 保持按业务分支并行的初始任务和现有并发上限。Child 同时研究 purpose、must_answer、写作维度、表图建议、业务关联、Evidence 和真实资料缺口，返回完整 Writing Brief。运行内候选池汇集所有分支材料；一次目录深化同步生成每个新叶子的任务定义和父节点摘要。后续单个轻量 Final Check 优先复用候选，只为具体问题局部检索，不能增删章节或调整层级。

短文件引用只属于模型输入输出，Host 通过本轮定位表回填真实 file_id 和 source_kind。正式 Evidence Map v10 和 missing_topics:string[] 保持不变。技术错误进入执行日志及有限修复，单条错误引用不丢弃同章有效材料，也不自动变成资料缺口。Final Check 无法形成有效章节结论时拒绝发布。

Draft 保持 CAS 与结构、覆盖校验。保存操作不覆盖最近研究完成的目录；最终确认才比较章节任务、业务关联及祖先语义，复核受影响叶子并同步摘要。排序不触发模型。确认失败恢复正式目录、资料和 Web ledger，保留 Draft；最终成功后才按引用清理快照。

S5 使用已确认的任务定义组织正文，不重新规划拆章或章节目标。Writer 获得全部允许语料的 locator，优先使用 S4 Evidence，遇到具体缺口时有限 grep/read；补搜实际使用的资料只写当前章节 Metadata。tender 不开放，outline_framework 仍只作草稿，不证明项目事实。

S4、S5 的 Corpus 读取 Guard 由各 Child 的工具作用域持有，随 Child 释放。Fresh-context Child 不继承父 Agent 的 Guard，父会话上的注册无法限制它的文件读取。

## Alternatives considered

**按 ID 机械继承，交给 S5 重新研究。** 不能保证合并双方资料都成为候选，也会让章节任务与资料关联脱节。S4 通过语义筛选确定最终关联，S5 保留有限补搜能力。

**每次编辑自动启动模型。** 连续调整会重复消耗研究时间；保存只做确定性校验，最终确认集中处理真实语义变化。

**逐章节独立 Agent、持久知识库或复杂拆分来源图。** 当前分支调度、内存候选集合与既有 Corpus 已足够支持复用；新增持久索引和来源状态会扩大一致性维护范围。

**把错误引用编码为业务缺口。** 技术修复与资料是否存在是不同结论；日志记录错误，missing_topics 由研究判断。

## Consequences

S4 增加一次轻量语义闭环，最终确认的耗时取决于实际受影响章节。Host 校验字段、覆盖、引用与结构，模型负责资料适用性和摘要准确性；脚本回放不证明真实模型的研究质量。不引入阶段内恢复协议、向量检索、Gap 状态机或 S5 Artifact 短引用迁移。

本记录部分替代[资料映射减法](../simplification/2026-09-03-bid-evidence-mapping-reduction.md)的自动继承、技术错误缺口和免复核确认规则，以及[等待态交互](2026-09-03-bid-waiting-user-stage-interaction.md)的编辑发布时机。这两份记录关于业务分支调度、来源证明、受控工具与生命周期的取舍仍有独立价值，保留并互相链接；更早的[章节证据新鲜度](../architecture/2026-09-03-bid-section-evidence-freshness.md)和[六阶段角色分离](../architecture/2026-09-02-bid-role-separated-evidence-flow.md)继续保留其 Corpus 权限与阶段职责依据。

定向验证覆盖跨分支复用、拆分与合并后的完整任务、技术错误隔离、排序免复核、确认失败恢复及 S5 未映射资料补检索；源码 Loader 回放固定 S4 研究与无工具 Final Check，以及 S5 拒读 tender 后使用未映射资料的真实会话和最终产物。前端仅运行受影响组件测试，不执行 build。
