# Agent Note: 浏览器文件接入队列限定于当前阶段和会话

Status: implemented

## Problem

`BidStagePanel` 保存浏览器选择的 `File` 对象以便用户上传或重试；Host Projection 进入后续阶段时，该临时队列仍会与新的阶段状态一起显示。

## Decision

`BidStagePanel` 只在 `file_intake` 阶段渲染浏览器上传队列。Projection 离开该阶段或面板切换到另一 Session 时，组件同时清空 `selectedFilesRef.current` 和 `selectedFiles` state。上传 Promise 结算不会清空队列，Host 拒绝和文件接入失败仍保留文件供用户重试。

## Alternatives considered

**在上传 Promise 成功后清空队列。** Promise 成功只代表请求已被 Remote 接收，不能替代 Host Projection 的阶段结论，也会丢失失败后的重试文件。

**将文件队列持久化为项目文件管理。** 这会混淆浏览器临时选择与 Host 持有的已上传文件，并扩大 UI 的职责，因此未采用。

## Consequences

后续阶段只显示 Host Projection 的当前状态，已上传并解析的 Workspace 文件不受浏览器队列清理影响。回归测试覆盖阶段推进和 Session 切换，原有 Host 拒绝后重试覆盖继续保留。
