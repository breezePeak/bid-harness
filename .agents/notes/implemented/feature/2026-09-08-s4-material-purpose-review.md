# Agent Note: S4 按任务依据复核材料用途与父节点总述

Status: implemented

## Problem

真实文件中的材料仍可能不适用于目标章节；材料与已扩展任务吻合，也不能证明任务扩展合理。材料提交夹带写作任务、补充模式合并旧维度和 baseline 免审会保留这种错误。父节点总述若只解释目录分工，不能自然用于正式标书。

## Decision

S4 保持初始分支研究、现有目录复核与 Final Check，不新增模型阶段，不修改 S5。程序从标准化 Markdown 的实际标题位置、层级和现有分块行号生成范围；重复标题按位置区分，区分直接正文与包含子节的范围，跨标题块明确显示全部覆盖。完整结构目录无法确定对应时标记“定位未确定”。read_source 与 search_sources 解析程序提供的引用并分页，初始研究、重映射与 Final Check 共用，通用本地 grep/read 不开放给 S4。

材料工具仅提交 material_ref、usage 和 summary，程序绑定真实文件与分块；summary 保存当前章节任务、可用内容和展开限度，跨章节分别保存用途。独立章节任务操作维护 Writing Brief、写作维度、覆盖关系及职责内缺口，记录招标要求、用户修改或章节职责依据以及前后差异。目录操作同样保留业务依据。相关资料本身不能成为扩展任务的理由。

目录轻量复核先接收最终章节任务、写作维度、材料研究用途和分支粒度结论；具体结构问题在进入 Final Check 前由对应研究分支有限修复。Final Check 对照 S3 原任务、S2 要求、用户修改、S4 差异和全书职责，先审任务调整，再审资料。程序以章节、材料身份或父节点生成稳定 `review_key`，以任务语义、材料用途及其任务 fingerprint、总述及后代职责计算 SHA-256 fingerprint；`review_ref` 只用于当前轮次。fingerprint 未变的 keep 继续有效，任务变化使本章任务、材料及祖先总述结论失效，材料来源或用途变化只使该关联待审。空材料章节仍有任务项，baseline 不算已审；修正后的新版本仍须复核，无参数 finish_final_check 按实际记录计算漏项与阻断。越界问题必须修正或阻断，Final Check 不获得结构编辑权限。

replace、supplement 与确认前复核都审最终合并结果，只涉及目标叶节及必要祖先；材料合并不能恢复旧写作维度。局部 Draft 中其他尚未研究的新叶节不视为已审，由确认前复核补齐；整本确认仍运行完整 Validator。父 summary 根据最终任务和确认信息写成自然技术标总述，不展开步骤、不新增承诺、不声称核验尚未生成的 S5 正文。文体和适用性由模型判断，程序只校验节点、非空和复核状态。

正式 Evidence Map v10、分块索引、S5 输入及前端接口不变。私有 checkpoint 的研究充分性与版本由[研究充分后再决定目录深化](../bug-fix/2026-09-11-s4-research-before-outline-refinement.md)定义，并继续在成功的 `review_items`、`replace_section_mapping`、`update_section_task`、`submit_branch_summary` 和 `finish_final_check` 后保存当前 mapping、任务操作、父节点总述、稳定复核记录、累计失效数及完成状态。失败恢复重算稳定身份和 fingerprint，复用仍有效的 keep；已完成 Final Check 可直接恢复，不再启动 Child。缺少这些事实的旧检查点必须重置 S4。正式产物在复核与整体验证后发布，沿用有限修复、关键写入和 Host 回滚。候选 Web 快照保留至发布后按引用裁剪。

本记录部分替代[章节研究与 Blueprint](2026-09-03-bid-section-research-blueprint.md)的材料任务合并与目录式概述、[增量映射工具](../simplification/2026-09-07-s4-incremental-mapping-tools.md)的 baseline 免审和章节提交字段，以及[目录结构与叶节写作](../bug-fix/2026-09-08-bid-outline-structure-before-writing.md)的 S4 检查点版本。旧记录仍保留分支调度、S5 补搜、同回合工具修复、完整目录和叶节标题约束的独立决策价值，不归档；更早的[资料映射减法](../simplification/2026-09-03-bid-evidence-mapping-reduction.md)及[等待态交互](2026-09-03-bid-waiting-user-stage-interaction.md)继续以各自后继记录为当前规则。

## Alternatives considered

**依靠同名标题或行业关键词拒绝材料。** 不能区分同一资料支持业务范围还是实施步骤；定位由程序保证，适用性由模型结合职责判断。

**只加强材料提示词，允许提交同时扩展任务。** 修改后的任务可能与材料自洽，却偏离招标要求和全书分工。独立操作与原始依据复核让任务调整本身成为审查对象。

**让模型声明全部已审，或将 baseline 视为已审。** 无法发现漏项、替换后过期和 supplement 旧材料未审。程序从候选生成集合并绑定版本，完成工具只消费实际结论。

**另建父节点 Writer 或修改 S5。** 已有 S4 summary 可直接承载正式总述，增加阶段会引入重复正文和状态。S5 继续消费同一确认产物。

## Consequences

程序维护运行内定位、任务操作和复核版本，增加明确的工具调用；模型仍承担业务判断。Branch Child 只展开当前分支、对应 S3 基线、局部差异和按覆盖关联筛选的候选引用，全书仅提供轻量职责索引；Final Check 只展开 pending 项、必要的总述依赖和 Web 引用。执行日志记录上下文规模与复核复用计数，不保存完整 Prompt。引用合法、记录齐全、单元测试和 Loader 回放均不能证明语义正确。跨业务真实模型样例使用固定正反对照，核对 S4 的章节与材料映射，并留存语义误配、资料遗漏、工具次数、耗时、映射产物与判断原句；自动评估之后仍需人工核对资料用途。
