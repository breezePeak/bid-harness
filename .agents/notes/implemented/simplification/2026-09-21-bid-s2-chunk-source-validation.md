# Agent Note: S2 chunk 级来源校验

Status: implemented

## Problem

S2 用 `anchor_text` 在 chunk 正文中做唯一精确匹配并回映行号。PDF 提取产生的换行、空格、标点和全半角差异会把真实来源误判为未命中或多次命中，触发无助于语义分析的 repair。

## Decision

S2 source 只验证三项事实：`file_ref` 对应 manifest 中 `role=tender && parseStatus=success` 的真实文件，chunk 存在且属于该文件，`anchor_text.trim()` 非空。Host 将去除首尾空白的 `anchor_text` 作为 quote，并写入真实 `file_id`、chunk artifact path、`line_start=1` 和该 chunk 实际总行数；不再匹配正文或计算精确行号。

现有 Artifact schema 和必填 `line_start`、`line_end` 保持不变。该决定取代原有的精确锚点协议，同时保留 Host 对文件身份和 chunk 归属的所有权。

## Alternatives considered

**继续扩展文本归一化。** 不采用；任何字符级规则仍会把 PDF 提取差异变成 repair，且不能证明语义忠实。

**放宽为模糊匹配。** 不采用；相似度阈值重新引入位置猜测和并列候选。

**让来源行号可选。** 不采用；这会改变既有 Artifact schema，超出本次来源定位简化范围。

## Consequences

S2 来源精度从文本片段调整为 chunk，`anchor_text` 本身成为 quote 和三类记录的 `raw_text`。文本未命中或多次命中不再触发 repair；最终 Validator 继续验证真实 tender、chunk 和行范围。
