# Agent Note: Word 模板二进制上传

Status: implemented

## Problem

Word 格式页把 DOCX 模板编码为 base64 后放入配置 Remote 的 JSON。模板原始字节上限提高到数百 MiB 时，编码膨胀、浏览器字符串拼接和 API 请求体限制会先于模板解析失败，配置请求也同时承担字段编辑与文件传输两种职责。

## Decision

浏览器把 DOCX `File` 直接交给独立同源二进制端点，请求头携带 Session、显示文件名、原始长度和配置 revision。Host 复用 [S1 二进制上传](2026-09-01-file-intake-batch-completeness.md) 的来源校验与精确长度读取，在项目锁内解析并保存模板；配置 Remote 只保存格式字段。页面存在未保存编辑时先保存编辑，再用返回的 revision 上传模板，使模板替换保留当前覆盖项和描述。

`docxTemplateMaxBytes` 是 Host 配置，默认 300 MiB，并通过 `DocxFormatView.templateMaxBytes` 返回浏览器。浏览器预检负责即时反馈，Host 的相同限制负责最终准入。DOCX ZIP 解析仍需要随机访问，因此 Host 在长度准入后把二进制请求体缓冲一次；传输过程中不创建 base64 字符串。

## Alternatives considered

**继续扩 Config Remote 的 JSON 请求体上限。** 不予采用，因为 base64 固有的体积和字符串内存开销仍存在，300 MiB 原文件会显著放大请求。

**把完整格式草稿放入自定义 HTTP 请求头。** 不予采用，因为格式描述和覆盖项会占用不可移植的请求头预算；文件端点只携带固定的小型元数据。

**增加 multipart 解析依赖。** 不予采用，因为模板只有一个文件，现有 S1 的原始二进制请求体和请求头元数据已经覆盖当前需求。

## Consequences

模板请求不会经过 Typert Remote，也不会把文件字节写入 JSON。前后端定向测试固定 300 MiB 默认值、超限拒绝和原始 `File` 请求体；Web 浏览器回放及可访问性快照固定二进制请求、模板文件落盘和页面呈现的真实链路。Host 峰值内存仍受模板原始字节上限与 32 MiB 解压内容上限约束；若需要在解析期间避免完整原始文件驻留，需要更换支持文件或流式 ZIP 读取的解析器。
