# Agent Note: S4 主题归位驱动目录锁定

Status: implemented

## Problem

S4 Section Child 在研究后用单个 `outline_capacity=adequate` 概括当前叶子可写性，Host 随即拒绝新增、拆分、合并、移动和删除操作。可写不等于目录粒度充分；总括结论会在模型逐项判断研究主题之前关闭结构编辑，并使自由文本 `comparison` 成为锁定目录的主要依据。

## Decision

研究先行、局部作用域和无机械拆分的决策继续适用。研究字段、主题归位时机、目录锁定及 checkpoint 由[Blueprint 后结构判断](2026-09-12-s4-blueprint-structure-assessment.md)定义。

中性研究发现保存真实依据，Structure Assessment 的 `topic_dispositions` 按 finding 序号逐项记录归位方式与理由。归位方式为 `separate_section`、`within_section`、`covered_elsewhere` 或 `excluded`；依据引用当前输入中真实存在的 Requirement、Scoring、Response Point、人工框架标题和参考目录标题，或当前 Child 成功本地搜索、读取和 Web Fetch 的引用。Host 校验身份和工具结果，不判断主题与依据的业务语义。

整体 KEEP/REFINE 标签不关闭目录操作。Research Ready 且完成 Blueprint 与首次结构判断后，Initial 与 Repair Child 保留当前 Section 子树内的现有目录操作；Host 校验编辑作用域、Section ID、操作一致性、共享树结构和覆盖关系。

`lock_section_outline` 读取最新 `topic_dispositions`。`separate_section` 必须具有由结构操作绑定的当前子树可写节点，该节点相对任务基线具有真实树结构变化；`covered_elsewhere` 必须指向存在且非当前 Section 的节点；其他归位由必填 placement 和 reason 完成。自由文本 `comparison` 只补充整体对照，不能替代逐主题状态和最终结构校验。目录允许没有结构变化，且不按固定层级、节点数、标题或行业词判定充分性。

现有 `reviewRefinedOutline()` 通过 Structure Review Cards 独立检查研究主题、Writing Brief 与实际目录的一致性，以及重复拆分、过度拆分和职责冲突；遗漏深化以 `OUTLINE_REFINEMENT_MISSED` 写入既有 `blocking_issues`。`structureRepairTasks()` 把重叠问题归并为最上层受影响子树并生成 `MAP-REPAIR-*`，动态叶任务和其他已完成 Section 沿用[逐叶队列](../architecture/2026-09-11-s4-leaf-mapping-task-scope.md)。

私有 S4 checkpoint v10 分别保存 Research Assessment 与 Structure Assessment；正式 Outline、Evidence Map v10 和 S5 输入不携带这些私有判断。旧 checkpoint 必须重置 S4。

## Alternatives considered

**保留 `adequate/refinement_needed` 的结构操作分支。** 单个总体标签无法证明每个研究主题都已归位，且会把“当前章节可写”误当成“目录无需深化”；逐主题记录提供锁定所需的确定性状态。

**由 Host 根据主题文本决定是否拆节。** 主题的独立方法、流程、成果、职责和论证完整性依赖业务语义；确定性代码只验证真实引用、目标节点和结构变化，语义遗漏交给现有 Reviewer。

**强制每个叶子或每个主题产生子节。** 固定层级和节点数量会把连续技术过程机械拆散，也无法适应不同招标书；零结构变化在全部主题合理留章内或归位他处时合法。

**增加主题分析阶段或第二个目录审核器。** Section Child 已拥有研究与目录工具，全书 Reviewer 已拥有局部修复回流；增加阶段会复制上下文、状态和修复机制。

## Consequences

每次结构判断逐项记录研究主题的归位理由；新增 Section ID 及真实目标绑定由 Host 保存。Host 能拒绝虚假依据、未知或自身的外部目标、未落实的独立成节主题和非法最终树，但不能证明模型列出了所有业务主题；全书 Reviewer 通过 Writing Brief、研究发现与结构差异发现这类遗漏。

定向测试覆盖无依据主题、未成功本地读取或 Web Fetch 的引用、未知或自身 `covered_elsewhere`、未形成结构变化的 `separate_section`、全部主题合理留章内的零结构变化、数量不固定的拆分与新叶入队、`OUTLINE_REFINEMENT_MISSED` 到 `MAP-REPAIR-*` 的局部回流、无关 Section 不重跑及正式 S5 输入不携带研究状态。模型可见提示和真实 Loader 回放固定新 schema、归位规则与 Web 决策机制。
