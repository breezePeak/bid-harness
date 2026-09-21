# Agent Note: S3 有界目录生成与 Artifact 恢复

Status: implemented

## Problem

S3 把响应点复核、目录修复和质量复核放在共享重试循环中，多个分支共同消耗次数并依赖内存 baseline 判断是否继续。进程中断后，旧 Run scratch、已发布正式文件和未持久化计数无法形成唯一恢复依据；质量复核修改目录还会触发新的完整复核，执行轮次没有静态上界。

## Decision

S3 按固定步骤执行：一个响应点分析 Child 在同轮完成语义自检；目录 JSON 格式修复至多一次；字段、引用、结构和覆盖的确定性修复合并为至多一次；Blueprint Quality Review 完整执行一次，漏交质量工具时只允许一次没有目录写权限的协议续行。任何步骤失败都立即结束当前 Run，不存在共享 attempts、review baseline 或不完整复核状态。

确定性修复应用成功时，Host 在同一 Commit Scope 中原子写入 `outline/outline.json` 与 `outline/repair-operations.json`。回执是已消耗修复机会的事实记录；恢复发现回执后只校验当前正式目录，仍有问题就失败，不再启动修复轮次。新目录生成或用户请求重新生成会使旧回执和质量报告失效。

正式恢复链依次使用 `analysis/scoring-response-points.json`、`outline/outline.json`、`outline/repair-operations.json`、`outline/quality-report.json` 和 `outline/draft.json`。未发布正式响应点清单时重新运行一次分析；已有清单时不再运行响应点 Child。已有目录但没有质量报告时只运行一次质量复核；质量报告有效时不再调用模型并补齐 Draft；Draft 存在时必须与正式目录的实际内容摘要和记录摘要一致。旧 Run scratch 不参与恢复，继续运行只复用正式 Artifact；阶段 reset 删除正式 S3 及下游产物后才从头开始。

质量复核可以在唯一完整轮次内修改目录，但必须在同轮自检并提交报告。Host 对修改后的目录重新解析、规范化并执行确定性校验，然后原子发布目录与质量报告。格式修复、确定性修复和质量复核不调用正式阶段 Validator；执行器只返回 Artifact 描述，由 Orchestrator 在阶段边界调用一次正式 Validator。

## Alternatives considered

**保留共享循环并把次数写入新状态。** 不采用；共享预算仍会让无关步骤互相影响，而且需要新增执行状态和迁移规则。

**继续读取旧 Run scratch。** 不采用；scratch 不是正式提交边界，跨 Run 读取会把未完成写入误当成可恢复事实。

**质量复核修改后再启动一轮完整复核。** 不采用；轮次数取决于模型行为，无法证明有界。唯一复核轮次明确要求修改后自检，Host 只做确定性验收。

**把正式 Validator 放回执行器。** 不采用；执行失败重试会重复阶段验收，模糊执行与编排职责。Orchestrator 保持唯一正式校验所有者。

## Consequences

正常 S3 只有一个响应点 Child、一次目录生成和一次完整质量复核；协议漏交最多增加一次纯提交续行。中断恢复由正式 Artifact 决定，不依赖内存计数或旧 scratch；已完成质量报告和 Draft 的 Run 不会重新调用模型。修复回执是新的正式阶段内文件，但不改变对外 Outline、质量报告、Draft 或工作流状态 Schema。

无密钥 Loader 回放覆盖正常路径和确认停点，单元测试覆盖响应点、目录、修复、质量报告、Draft 各检查点以及 continue 与 reset 的差异。真实模型仍负责响应点拆分和目录语义质量，确定性校验不能替代真实 Web 项目的人工抽查。
