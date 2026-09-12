# Agent Note: S4 研究充分后再决定目录深化

Status: implemented

## Problem

Section Child 可以在研究过程中交替修改目录和起草 Writing Brief，单独的目录锁定只保存自由文本粒度结论。程序因此无法区分“研究已经足以支持结构判断”和“先形成目录、再寻找资料补理由”，全局目录复核也缺少各 Section 的完整研究充分性依据。

## Decision

研究先行、局部作用域和无机械拆分的决策继续适用。研究字段、主题归位时机、目录锁定及 checkpoint 由[Blueprint 后结构判断](2026-09-12-s4-blueprint-structure-assessment.md)定义。

Initial 与 Repair Mapping Child 先理解 S3 章节职责、识别研究问题并读取本地或 Web 资料，再通过 `submit_section_research_assessment` 提交结构化判断。判断覆盖招标要求与 Response Point、技术原理和实施路线、依据与推断边界、项目特有信息及质量风险约束，并记录中性关键发现、影响 Blueprint 设计的未解决缺口。Host 根据 finding 文本分配稳定 `finding_ref`，使重复提交中的同一发现保持同一引用。

`MappingSubmissionState` 只有在 `sufficient_for_blueprint=true` 时进入 Research Ready。Host 在此前拒绝 `apply_section_outline_edit`、`lock_section_outline` 和 `update_section_task`，但保留资料搜索、读取及重复评估；不足结论会重新关闭这些操作。充分性不按网页、资料或工具调用数量决定，招标信息足够时允许零联网。客观不可获得的信息可以保留，但声明 Ready 时不得存在仍影响当前 Blueprint 设计的缺口，也不得以推断冒充依据。

Research Ready 后，Child 形成完整 Blueprint，再根据关键发现判断职责、目标、方法、输入输出或验证方式不同的主题是否值得在 S5 独立论证，并检查兄弟章节重复。Host 根据目录操作中的 finding 序号保存真实引用并自动保留已用发现，只验证引用归属，不判断 finding 与操作的语义匹配；版本失效和自动绑定规则见[Blueprint 后结构判断](2026-09-12-s4-blueprint-structure-assessment.md)。

私有 S4 checkpoint v10 保存 Initial、Repair 和动态新叶任务的最终研究记录、结构判断与稳定引用。Repair 使用中性发现与当前任务，全局复核继续用现有 blocking_issues 定位 MAP-REPAIR-*；不增加第二套目录审核。任务与编辑作用域遵循[逐叶研究任务](../architecture/2026-09-11-s4-leaf-mapping-task-scope.md)。

本记录替代[目录结构与叶节写作](2026-09-08-bid-outline-structure-before-writing.md)和[增量映射工具](../simplification/2026-09-07-s4-incremental-mapping-tools.md)中研究、任务草稿与目录编辑交替进行的顺序，并替代[材料用途与职责复核](../feature/2026-09-08-s4-material-purpose-review.md)中的 checkpoint v5。旧记录继续分别约束完整目录输入、叶节写作、增量工具、材料用途与 Final Check，保留并互链。

## Alternatives considered

**按固定网页数、资料数或工具调用数放行。** 数量不能证明关键结构问题已研究，也会错误阻止招标信息已经充分的分支；结构化诊断由模型判断充分性，Host 只校验状态与矛盾字段。

**把研究判断并入 `lock_section_outline` 的 comparison。** 自由文本无法在目录操作前形成程序门禁，也不能可靠提供给恢复、Repair 和全局复核；独立 assessment 保存当前 Section 的权威研究状态。

**由 Host 判断 finding 与目录操作是否语义一致。** 语义匹配依赖完整业务上下文，确定性代码无法可靠判断；Host 只验证引用来自当前 assessment，全局目录复核继续判断研究发现与最终目录是否一致。

**新增研究阶段或第二套目录审核。** Section Child 已拥有资料工具和目录操作，现有 `reviewRefinedOutline()` 已拥有局部修复回流；增加阶段或审核器会复制上下文、状态与修复路径。

**禁止带有任何未解决缺口的 Ready。** 一些项目特有信息客观不可获得但不改变当前层级，只影响后续写作细节；保留其真实边界比强迫虚构或永久阻塞更准确。

## Consequences

每个 Initial 与 Repair Section 增加至少一次结构化工具调用，研究不足或研究内容改变时会有重复评估。Host 能证明目录和 Writing Brief 操作发生在充分结论之后、最终 Research Assessment 覆盖全部已用于目录修改的研究发现，并能把中性研究内容用于恢复、局部 Repair 和全局复核；研究内容、充分性和操作语义仍由模型负责。正式 Evidence Map v10、目录 Artifact 和 S5 消费语义不变；私有 checkpoint 为 v10，旧私有 checkpoint 需要重置 S4。

定向单元测试覆盖未评估和不足状态的拒绝、继续检索与重新评估、稳定 finding ref、已用 finding ref 的自动保留、非法 finding 序号、两种结构判断、有效结构调整、checkpoint 恢复和 Review/Repair 输入；真实 Loader 回放固定模型可见工具顺序及最终 S5 输入兼容性。
