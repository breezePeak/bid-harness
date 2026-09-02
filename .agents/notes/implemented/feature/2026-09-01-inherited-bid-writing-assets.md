# Agent Note: 人工框架和旧标书继承式技术标生成

Status: implemented

## Problem

技术标文件接入仅区分招标文件和参考资料，人工目录框架、已有正文、相似项目旧标书与一般技术资料失去业务优先级。后续阶段无法稳定继承人工结构、复用成熟章节或逐个响应技术评分点。

## Decision

文件接入持久化 `tender`、`outline_framework`、`reference_bid` 与 `reference` 四类角色。S2 仅从 `tender` 提取当前项目要求；S3 适配成功解析的 `outline_framework` 并保存精确标题引用；S4 与 S5 把 `reference_bid` 和 `reference` 作为权限不同的本地 Evidence，S5 另把命中的框架正文作为写作输入。跨阶段职责由[文件角色分离的数据流](../architecture/2026-09-02-bid-role-separated-evidence-flow.md)定义。

人工框架或本地资料缺失不是异常。S3 可按评分响应点、评分项、Requirements 和 Compliance 从头生成目录；S4 允许只记录资料缺口，不增加控制面阶段或独立检索系统。

## Source priority

当前 `tender` 的技术要求、评分点和合规约束优先于人工框架。人工框架只拥有目录骨架优先级；参考旧标书只拥有正文复用与适配权限；普通项目资料用于事实和技术参考；公开资料只补足公开技术知识。旧项目名称、周期、参数和承诺不得覆盖当前招标事实。

## Artifact changes

Evidence Map、Outline、Outline Quality Report 与 Chapter Metadata 使用严格版本化 Artifact。旧 Session 不会被静默填充为新字段；受影响阶段必须重新生成。Manifest 的四种合法角色保持当前版本和身份。

## Alternatives considered

**新增框架分析和旧标书分析阶段。** 这会扩大六阶段控制面并增加不必要 Artifact；S3 可直接读取框架结构，S4 已能按本地资料角色处理旧标书。

**将所有补充文件继续视为 `reference`。** 这不能表达人工框架和旧标书的优先级，也无法约束 S3 和 S5 的继承行为。

**新增向量检索或旧标书知识库。** 现有结构、Chunk 索引、`grep`、`read` 和 Web 取证已覆盖本次来源定位需求；引入检索基础设施扩大范围且不能解决角色和映射缺失。

## Consequences

只有成功解析的 `tender` 即可完成 S1 并推进到 S2；四类角色在 Remote、Manifest、模型可见库存和文件列表中保持一致。S3 消费人工框架与评分 Response Point，S4 只映射普通资料、旧标书和 Web Snapshot，S5 记录可追溯 Evidence 身份并读取当前 Section 命中的框架正文。

S4 与 S5 使用真实 file、chunk、角色、Web 来源账本和 Snapshot 哈希验证 Evidence 身份；S3 从原始框架结构生成带稳定引用的初始目录，S5 按引用读取正文但不把它写入 Evidence 记录。聚焦 Host、Evidence Mapping、Outline、Chapter Writing 与 UI 测试共同覆盖该链路。详见 [S3 Host 确定性合并](../simplification/2026-09-01-s3-host-evidence-canonicalization.md)。
