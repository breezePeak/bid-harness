# Agent Note: 人工框架和旧标书继承式技术标生成

Status: implemented

## Problem

技术标文件接入仅区分招标文件和参考资料，人工目录框架、已有正文、相似项目旧标书与一般技术资料失去业务优先级。后续阶段无法稳定继承人工结构、复用成熟章节或逐个响应技术评分点。

## Decision

文件接入持久化 `tender`、`outline_framework`、`reference_bid` 与 `reference` 四类角色。S2 仅从 `tender` 提取当前项目要求；S3 在既有 Evidence Map 中记录框架映射、旧标书映射、来源策略和评分 response point 写作维度；S4 将这些映射转化为可写目录；S6 按保留补充、适配改写或新写策略消费对应正文。

特殊资产缺失时，S3 使用 `generated_from_scratch` 策略，基于当前招标要求和可用资料生成目录，不增加控制面阶段或独立检索系统。

## Source priority

当前 `tender` 的技术要求、评分点和合规约束优先于人工框架；人工框架优先于参考旧标书；参考旧标书优先于其他技术资料；公开资料和模型通用知识仅补足缺口。旧项目名称、周期、参数和承诺不得覆盖当前招标事实。

## Artifact changes

Evidence Map、Outline、Outline Quality Report 与 Chapter Metadata 使用严格版本化 Artifact。旧 Session 不会被静默填充为新字段；受影响阶段必须重新生成。仅扩展 Manifest 的合法角色时保持已有 Manifest 版本，使旧的 `tender` 和 `reference` 记录仍可读取。

## Alternatives considered

**新增框架分析和旧标书分析阶段。** 这会改变现有八阶段控制面并将同一写作准备拆成多个 Artifact，因此保持在 S3 的既有 Evidence Map 中。

**将所有补充文件继续视为 `reference`。** 这不能表达人工框架和旧标书的优先级，也无法约束 S4 和 S6 的继承行为。

**新增向量检索或旧标书知识库。** 现有结构、Chunk 索引、`grep`、`read` 和 Web 取证已覆盖本次来源定位需求；引入检索基础设施扩大范围且不能解决角色和映射缺失。

## Consequences

只有成功解析的 `tender` 即可完成 S1 并推进到 S2；四类角色在 Remote、Manifest、模型可见库存和文件列表中保持一致。S3 对四种来源策略生成并校验映射，S4 消费每个有效 Mapping 与评分 response point，S6 消费指定框架或旧标书内容并记录可追溯 Metadata。

Artifact 字段跨 S3 至 S6 传播，版本和引用验证遗漏会阻止阶段推进。S3 与 S6 使用真实 file、chunk、角色和章节归属验证；S3 不持久化行号或复制源章节标题、层级、顺序和路径，S6 从原始结构 Artifact 解析这些元数据。聚焦 Host、Evidence Mapping、Outline、Chapter Writing 与 UI 测试共同覆盖该链路。详见 [S3 Host 确定性合并](../simplification/2026-09-01-s3-host-evidence-canonicalization.md)。
