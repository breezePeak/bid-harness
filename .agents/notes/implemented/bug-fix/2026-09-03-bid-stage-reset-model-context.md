# Agent Note: Bid 阶段重置清除模型上下文

Status: implemented

## Problem

阶段重置删除 Workspace Artifact，但复用同一 Agent 的模型消息历史。模型会把已删除阶段的旧修复任务带入新的阶段执行，导致首次重跑只修复旧文件而不是产出该阶段的完整 Artifact。

## Decision

`BidHostRuntime.resetStage()` 在删除目标阶段及后续 Artifact 后清空 Agent inbox，并以一次模型可见替换移除目标阶段及后续阶段的当前消息。重置标记保留在模型上下文中，要求新的执行只依据当前 Workspace 文件和新的阶段指令。

持久 Session 日志保持追加式；被替换的原始消息仍可用于审计和回放，但不会进入后续模型请求。

## Alternatives considered

**仅删除 Artifact。** 不采用，因为模型仍会接收旧阶段推理和工具结果。

**物理删除 Session 记录。** 不采用，因为 Session 日志是追加式审计记录，删除会破坏回放和事件序号。

**为每次重置创建新 Session。** 不采用，因为需要复制已解析语料、重新绑定 Workspace 与用户任务，超出阶段重置的职责。

## Consequences

所有 `resetStage()` 入口在重置后的首次模型回合都不再继承目标阶段或后续阶段的旧上下文。每个替换事件携带被移除的消息序号，Session 日志尺寸不会因重置而缩小。
