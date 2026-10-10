# Agent Note: Bid Main Agent 保留通用工具

Status: implemented

## Problem

Bid preset 已挂载 Shell、文件和 Skill 工具，但阶段交互的 restriction 和 guard 在公开回合隐藏或拒绝继承工具。S4 失败后生成独立 Word、等待确认时整理文件以及后台写作期间编写脚本均无法执行；阶段业务权限与普通文件任务被混为一项限制。

## Decision

公开 Main Agent 保留 preset 配置的通用工具，阶段状态仅决定业务工具的挂载。移除等待确认和公开 inbox 回合的通用 restriction，以及对应的阶段工具强制 guard；同项目另一 Interaction Session 的运行所有者 guard 仅拦截 `bid_*` 业务调用。独立任务沿用既有 Skill、FS、Shell、Sandbox 和 Approval，不新增文件生成工具或交付协议。

正式阶段修改、确认和发布仍通过 Host 校验；私有 finish 工具仅属于 Execution Session，Goal 创建保留显式命令入口，Run 恢复保留真实用户授权，Web 调用继续服从业务开关。普通文件输出不改变正式阶段，不恢复 Run，也不触发 S6。

当前 `workspace-write` 可写整个会话工作区，包含 `.bid-harness/`。本次采用用户明确选择的现有权限范围；Persona 和阶段提示要求独立路径，但不构成正式产物拒写策略。直接文件写入可绕过 Host mutation 校验，这项风险归属 [Bid 限制说明](../../../../packages/bid/bid/README.md#known-limitations-and-deferred-work)。

本记录部分替代[等待确认阶段交互](../feature/2026-09-03-bid-waiting-user-stage-interaction.md)和[全阶段 Main Agent 交互](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)中的通用工具封禁；两者的 Draft CAS、局部研究、交互与执行所有权及私有协议规则保留独立决策价值。

## Alternatives considered

**向阶段白名单逐个追加通用工具名。** 会重复 preset 的能力配置，新增通用工具仍需修改业务插件。

**新增普通文件生成业务工具或自动调用 S6。** 独立文件处理不需要正式导出授权；现有 Shell 和库已经能够执行。

**扩展沙箱以排除正式产物目录。** 能提供强制隔离，但需要修改共享策略及执行器；用户选择先恢复工具并保留现有权限。

## Consequences

公开消息能够在失败、等待确认、运行和挂起状态执行普通文件任务。模型仍须区分独立输出与正式业务修改；Host 对业务入口的校验不会阻止通用工具直接写正式文件。无密钥 Loader 回放使用正式 preset、真实文件后端和平台 Shell 生成有效 OOXML；后台运行和跨 Session 测试同时核对正式状态与在途任务保持不变。真实模型的工具选择质量需要有密钥回归，浏览器任意工作区文件下载属于现有 UI 的独立能力。
