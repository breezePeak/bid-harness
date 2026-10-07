# Agent Note: S1 资料上传阶段重置命令

Status: implemented

## Problem

Bid 用户需要在同一项目回到资料上传入口。Host 支持 S1 重置，但 Bid Preset 的固定命令菜单缺少入口。

## Decision

Bid Preset 注册无参数 `/bid-reset-s1`，调用已有 `resetStage(agent, 'file_intake')`。Host 取消并等待当前执行静止，在项目操作内清理分析、目录、正文、私有工作目录和导出产物，持久化 `file_intake / waiting_user / run: null`，不创建执行 Agent 或自动驱动。

S1 重置保留已上传原文件、解析语料、资料清单和 Word 格式配置；下一批上传沿现有资料接入路径处理。该命令提供项目阶段回退，不承担删除项目或替换全部原资料的职责。

本决定取代[中断恢复与阶段重置](../bug-fix/2026-09-01-bid-interrupted-stage-recovery.md)中不公开 S1 的限制；其他取消、并发及重置规则继续有效。

## Alternatives considered

**为 S1 新增专用 Host 方法或 Remote。** 现有 Host 重置已拥有取消、项目锁、产物清理和持久化；增加另一条写入路径会重复这些规则。

**回到 S1 时删除已上传资料。** 用户请求的是阶段重置，已上传资料仍可复用；删除原文件和清单会扩大操作范围，因此保留它们并在命令描述中说明。

## Consequences

用户可从 Bid 命令菜单选择 S1 并重新上传，无需新建项目；阶段派生成果需要重新生成。命令单测、Host 重置测试和真实源码 Loader 快照核对命令分派、等待状态、产物清理、输入保留及恢复后的上传能力。
