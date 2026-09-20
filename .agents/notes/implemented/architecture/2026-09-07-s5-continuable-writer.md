# Agent Note: S5 同一 Writer 多轮修复与目录编号

Status: implemented

## Problem

章节修复创建新的 Writer 会丢失原会话中的资料判断与修改上下文，固定一次修复又不能表达部署配置。业务流程先后被误判为写作依赖时，无依赖章节也会串行。正文自编编号与确认目录分离，会让页面和导出的内部标题从 1 重新开始。

## Decision

Host 每章持有一个 continuable Writer，首轮请求前安装私有 `submit_chapter`。语义修复通过 followup 返回同一 child session，每轮清理提交状态，保持资料短引用稳定；每个候选使用独立 Reviewer。默认允许初稿加三次修复，通过即结束，耗尽后保留最后已审合法候选及实际问题。工具内参数纠错不消耗语义轮次，模型错误使用独立有界预算；会话创建或续写失败时才重建并记录基础设施失败。

本轮完成以新 `turn/end` 和本轮权威 `tools/result` 为依据，等待 Agent 静止后读取提交；旧结果、普通文本和初始 idle 不能完成新候选。协议轮次拒绝旧异步工具发布，取消及退出等待 continuable 子代理排空。会话持久化允许列目录后项目目录已消失，包括 Windows 原子建目录的临时目录；其他读取错误仍传播。

规划提示要求强依赖说明必须消费的具体决策及 S2/S4 无法提供的原因。共用背景、资料、术语和业务先后仅形成弱关联或全局约束，Host 保留完整性、引用与无环检查，不按关键词删除模型依赖。Reviewer 区分需要证据的项目事实、硬要求及既有能力，与明确提出且不违背采购要求的实施方案。

Host 在审查前按确认目录生成唯一根标题，落盘、引句和哈希共同绑定规范化候选。叶节的下级目录由 S4 确认，S5 不生成节内编号；标题接受规则见[目录结构与叶节写作](../bug-fix/2026-09-08-bid-outline-structure-before-writing.md)。Word 使用同一根标题编号并调整标题层级；页面通过独立页眉显示根标题，正文不重复显示。

用户在章节完成后提交修订时，Host 从执行日志恢复原 Writer 及其父会话；恢复失败拒绝修订，不能创建替代 Writer。批量修订只接受属于同一原 parent 的目标 Writer，由该 parent 调度全部续写；混合 parent 的批次在模型运行前拒绝。独立引用标签携带原文哈希，段落标签另带连续顶层段落的位置与原文，用户意见中的整章措辞不能扩大 Host 记录的授权范围。

paragraph-only task 进入独立 Fast Path：Host 合并重叠或相邻选区，只向原 Writer 提供授权段落和前后各一个只读顶层块，Writer 通过 `submit_paragraph_revision` 返回一一对应的 replacement。Host 按偏移倒序替换并重复执行范围、标题、流程图 anchor、表题、内部编号和非空检查；该协议不接受 metadata，也不开放资料读取或联网工具。轻量 Delta Reviewer 只判断审批意见满足度与技术语义是否保持，最多驱动一次局部 repair；改变技术事实、参数、承诺、评分响应、证据或 handoff 时不发布局部候选，改由完整章节路径处理。paragraph 模式的完整 Reviewer fallback 只有未满足的当前审批意见能形成本轮 blocking repair。

Fast Path accept 将正文、任务级 comparison、Delta Review、章节 semantic lineage 和 manifest 当前正文摘要放在同一 publication 中，meta 文件与原完整 Chapter Review 保持不变。lineage 逐项绑定 comparison 与 Delta Review 的身份和 before/after 摘要；Workbench、检查点和最终 Validator 只有在整条链连续、全部意见 satisfied 且 `semantic_preserved=true` 时，才把原完整章节审核、全局审核和整书语义证据视为当前正文的有效历史基线。当前标题、流程图、表题、内部编号、格式、页数和其他 Host 确定性事实始终按现正文重新校验。

## Alternatives considered

**每次修复新建 Writer。** 独立章节需要独立会话，但同章修复需要保留已作出的资料判断；Reviewer 的独立性由每轮新会话保证。

**根据业务关键词强制去掉依赖。** 关键词无法证明依赖是否真实，会破坏必须汇总最终成果的章节；语义交给模型，结构约束仍由 Host 校验。

**只在页面修正编号。** 保存正文、Reviewer 引句与 Word 会出现不同内容。审查前规范化能使三者引用同一候选。

**按章节恢复多个原 parent 后分别执行批次。** 批次依赖、失败传播和发布由一次章节执行统一结算；拆成多个父会话会产生多个部分执行边界。当前 S5 同次执行的 Writer 共用 parent，Host 对不一致检查点拒绝整批执行。

**段落选区继续复用完整 Writer 与完整 Reviewer。** 该路径要求模型重新提交整章并重复全章证据审查，既扩大输入输出，也让选区外问题进入 repair；replacement 协议从数据结构上限制写权限，Delta Reviewer 只在技术语义改变时升级为完整审核。

## Consequences

Writer 历史随修复增长，但每章保持稳定身份。整章修订继续使用原完整 Writer、独立 Chapter Reviewer、Global Reviewer 和 Completion Reviewer；普通 paragraph-only 修订只增加一次 Writer followup 和一次 Delta Reviewer，修复时各再增加一次。语义 lineage 保留旧审核证据的真实历史正文，不改写旧审核摘要冒充新审核。用户修订使用 `reviseChapter` Remote，批量修订要求目标 Writer 共用原 parent。完整 Reviewer、fallback 与检查点恢复仍遵循[私有提交协议](2026-09-07-s5-private-submission-protocols.md)及[故障隔离](../bug-fix/2026-09-04-bid-chapter-checkpoint-fault-isolation.md)，这两份记录保留各自的证据校验与持久化理由。

定向协议、AgentLoop 和真实 Loader 的无密钥回放覆盖三章并发、同一 Writer 两次修复后通过、预算、取消及过期提交。确定性测试验证调度和协议，不证明真实模型对依赖或事实适用性的判断质量；真实模型验收另行检查计划中的依赖原因、实际重叠区间和各轮 Writer 身份；单个项目全部通过审查不证明任意项目的事实判断均正确。
