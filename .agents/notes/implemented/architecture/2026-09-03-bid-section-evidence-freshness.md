# Agent Note: S4 任务拓扑与章节证据新鲜度由 Host 确定

Status: implemented

## Problem

模型生成的任务分组允许 Section 合并或重复，无法保证任务数等于目录中的可写叶子数。Manifest 的 Corpus 路径以 Session 为基准，Child 却继承父工作目录；目录 grep 与文件 read 共用过滤规则又拒绝正常搜索。仅按 Section ID 保存证据无法识别目录语义变化，最终用户编辑还可能直接产生空证据占位。把这些 Host 故障交给模型修复会重复消耗同一任务的 Token。

## Decision

Mapping Task topology is Host-owned and exactly one task per writable leaf Section; semantic research remains Agent-owned.

S4 与 S5 共用可写叶子的树遍历。Host plan v4 保存唯一 Section ID、确定性 task_id、真实标题路径、initial/supplemental、Section 指纹和目录摘要。Child 不接收其他 Section，只接收本章检索上下文、关联 S2 记录和预检 Corpus 定位。Main Agent 只负责一轮目录深化及复核。

Evidence Map v9 保存 Host 计算的 section_fingerprint。指纹使用固定字段序列化与 SHA-256，包含祖先标题路径、purpose、must_answer、业务引用、全局及本章合规要求、writing_notes 和表图建议。Section 的排序与展示属性不参与指纹。目录深化和用户最终编辑都使用同一指纹规则选择补充任务；已删或变为 structural 的 Section 不进入最终 Evidence Map。最终 Validator 与 S5 准入检查集合相等、无重复及指纹相等。

Corpus 预检仅处理成功解析的 reference/reference_bid，验证 Session 内归属、符号链接、索引 Schema 和登记分块是否存在。绝对路径同时用于 Prompt、Guard 和材料校验。grep 授权分块根目录或登记分块，read 授权索引或登记分块；本地引用还必须对应当前 Child 成功 read 的日志。损坏 Corpus 在任何 Child 启动前以 EVIDENCE_MAPPING_CORPUS_INVALID 失败并写入具体文件诊断。

材料为空可以正常完成；模型 JSON、Schema、Section 归属、未读分块和 Web 来源不完整允许同 Child 有限修复。Host、文件系统、工具或 Provider 不可用、Guard 异常和 Web 结果无法关联立即使任务及阶段失败。Web search→fetch、同会话跨轮来源、Snapshot 与哈希校验保持完整。最终确认等待补映射和验证后发布 confirmed-outline.json 与 S5 的 confirmation.json。

## Alternatives considered

**共享研究时合并或重叠任务。** 拒绝。共享检索可以通过缓存优化，但不能改变章节覆盖拓扑或使任务计数偏离初步目录。

**继续维护独立的章节变化字段比较。** 拒绝。指纹既用于调度也用于最终验证，双重规则会使目录变化判断与 Evidence 有效性再次分离。

**让 Child 推测 Corpus 路径或修复 Host 故障。** 拒绝。Manifest 与实际工作目录属于 Host，模型没有修复路径、权限或结果通道的权限。

**用户新增章节时制造空证据。** 拒绝。合法空材料必须来自已完成研究的 Child 结论，不能替代未执行的资料映射。

## Consequences

旧 Evidence Map v8 和模型任务计划不兼容，需要重新执行 S4。初始任务数等于初步确认目录的可写叶子数，补充任务单独计数。仅兄弟排序变化可以复用证据，祖先标题变化会刷新后代。证据指纹证明它针对当前章节检索上下文生成，不证明资料或模型摘要在语义上真实，也不检测同一个文件身份下正文被外部替换的语义变化。

本记录部分取代[并行资料映射](../feature/2026-08-30-bid-evidence-mapping-agent-stage.md)中的动态任务规划；该记录保留 Provider、文件角色与并发设计依据。[同会话修复](../bug-fix/2026-09-02-bid-evidence-mapping-continuation.md)保留跨轮 Web 来源、Session 恢复及 Snapshot 归属机制。验证覆盖确定性任务、真实 cwd、Windows 分隔符、权限、损坏 Corpus、重试分类、无资料、目录深化、最终确认及 Web 来源；真实 Loader 回放固定 Child 的检索与修复对话。
