# Agent Note: S1 上传批次完整性

Status: implemented

## Problem

浏览器可在同一 S1 请求中选择招标文件和旧参考标书，但 Host 在逐项解码后允许已解码子集继续入库。未解码或未由导入器返回的已选文件不参与 Manifest 校验时，S1 仍可能完成，后续阶段无法得知该材料缺失。

## Decision

`BidHostRuntime.uploadFiles()` 在任一请求文件解码失败后使 S1 失败。`validateFileIntake()` 还将 Host 已解码的完整请求批次与 `BidWorkspace.import()` 返回记录逐项比对，并继续校验每条返回记录对应的原文件和 Manifest 记录。缺失的请求文件产生 `FILE_INTAKE_SELECTED_FILE_MISSING`，因此 S1 保持失败而不会推进到 S2。浏览器编码保留每个文件的 `role`，回归测试覆盖 `tender` 与 `reference_bid` 请求、`input` 原文件和 Manifest 角色。

## Alternatives considered

**仅验证 Manifest 中已有记录。** 不予采用，因为缺失文件没有返回导入记录时不会进入该验证循环。

**保留可解码文件并将 S1 标记成功。** 不予采用，因为用户选择的材料集合是一次 S1 的完整输入，静默丢弃会改变后续生成可用的证据。

## Consequences

包含无效编码的批次可能已写入可解码文件，但 S1 会记录失败，用户不能在该状态进入 S2。重试仍通过现有 S1 流程处理；没有为其他阶段增加校验或行为。
