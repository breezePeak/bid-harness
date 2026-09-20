# Agent Note: S3 响应点使用当前评分 ID

Status: implemented

## Problem

S2 Host 为评分项分配 `SC-*` 稳定 ID，但 S3 响应点分析提示曾使用 `SCORE-*` 示例。模型可能照抄示例写入不存在的 `scoring_id`，使 Host 在生成正式响应点清单时拒绝候选。

## Decision

S3 Host 把当前 `scoring.json` 的完整结构和全部合法评分 ID 直接注入响应点分析与语义复核 Child，要求模型逐字复制这些 ID，不提供固定 ID 格式示例。Host 对两轮 structured output 继续拒绝未知评分 ID。

## Alternatives considered

**只把固定示例改为 `SC-*`：** 不能覆盖测试夹具、历史输入或其他合法 ID 形态，仍让模型依赖格式猜测，因此未采用。

**放宽 Host 校验并尝试按文本匹配评分项：** 会模糊稳定 ID 的边界，可能把响应点错误绑定到评分项，因此未采用。

## Consequences

S3 两轮响应点任务都包含当前项目的精确评分 ID，降低首次生成或复核既有候选时产生未知引用的概率；Host 只在严格归属校验通过后写 Candidate，错误输出不会被静默修复或落盘。已有失败项目可直接重试 S3，由语义复核检查 Host 提供的遗留候选。

## Testing

回归测试断言 S3 首轮分析和语义复核提示列出当前评分 ID，且分析提示不再包含 `SCORE-...` 固定示例。
