# Agent Note: Bid 专用文件接入操作

Status: implemented

[English](2026-08-29-bid-file-intake-action.md) | 中文

## Problem

Bid 面板可以选择文件，但 S1 没有把浏览器字节送入 Session 工作区的生产路由。通过 `session.prompt()` 发送这些字节会让通用聊天消息成为工作流权限来源，而由浏览器推进阶段则会产生无法从 Session 日志恢复的状态。

## Decision

Bid 包导出 browser-safe 上传请求与结果类型，并生成唯一的 Typert Remote `bid/uploadFiles`。Host 解析实时 Session，要求其解析后的 Preset 为 `bid`，只从 `Session.header.cwd` 获取工作区根目录，应用 Host 配置的文件限制，并以 per-Session 锁串行化接入。MVP 请求通过规范 base64 JSON 携带一个完整批次。

全部字节通过准入后，Host 启动当前程序负责的 `file_intake` 阶段，并把持久化、提取和分块交给 `BidWorkspace.import()`。文件接入 Validator 读取当前 `manifest.json`，逐一匹配本次批次的记录，并检查原文件、解析正文、必需提取 sidecar、分块索引和每个已索引分块。Orchestrator 记录完成或失败，Session Projection 派生客户端状态，Remote 返回前刷新终态事件。接入成功后立即把同一 Session 交给已实现的招标分析阶段，随后 Host 停在 `evidence_mapping/pending`；失败接入保留持久化记录，并接受新的上传尝试。

浏览器本地只保存选择结果和请求反馈。用户明确点击上传后才调用生成的 Remote，且浏览器绝不推导工作流完成，也不会退回 `session.prompt()`。

## Alternatives considered

**复用普通消息附件。** 不采用，因为该路径属于通用 Prompt 准入，也不提供 Bid 阶段事件序列。

**在现有 Remote assembly 外增加第二套上传服务。** 不采用，因为 Typert 已提供 Session 解析、结果封装和浏览器 API contribution。

**在浏览器推进 `file_intake`。** 不采用，因为重载和并发客户端必须从 Host 事件恢复同一状态。

## Consequences

S1 具有唯一的 Host-owned 接入路径、稳定业务错误和确定性回放。JSON/base64 MVP 会在配置限制内缓冲编码后的批次。S2 由[招标分析 Agent 阶段](2026-08-30-bid-tender-analysis-agent-stage.zh.md)负责；后续业务执行仍未实现。
