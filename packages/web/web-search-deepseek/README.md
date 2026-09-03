# @deepseek-ai/dsh-web-search-deepseek

网页搜索策略桥接插件：把 [web 服务](../web/README.md) 的搜索请求交给当前 [LLM Provider](../../llm/llm/README.md) 提供的 hosted `web_search`。插件依赖 `web`、`llm`、`agentDefaultModel`，面向模型的工具仍由 [tool-web](../tool-web/README.md) 注册。

包名、settings namespace 和 web 服务注册 ID `deepseek-official` 保持稳定，供已有组合引用；该 ID 不决定实际使用的模型 Provider。

## 配置

| 字段 | 默认 | 行为 |
|---|---|---|
| `provider` | 省略 | 跟随发起搜索的 Agent 最近请求中的 Provider；没有 Agent 时读取全局默认。显式设置时只调用指定 Provider。 |
| `maxUses` | `5` | 一次辅助请求允许的 hosted 搜索次数，必须为正整数。 |

插件页只编辑这些策略字段。API Key、Base URL 和模型由模型页及 Provider 的 settings namespace 管理；插件页不读写凭据。显式搜索 Provider 与任务 Provider 不同时，使用该搜索 Provider 模型目录的首项；可在模型页调整目录顺序。没有模型或没有 hosted-search 能力时明确失败，不自动换用其他 Provider。

## 旧配置迁移

首次搜索在发送请求前，将 `web-search-deepseek` 中的 `apiKey`、`apiKeyEnv`、`baseURL`、`model`、`apiVersion`、`maxTokens` 移入 `llm-deepseek.search`。已配置的 Provider 字段优先，迁移先持久化目标，再删除旧 user 层字段；失败时不会先丢弃旧值。组合文件内的静态字段保留作为迁移输入，Provider 中的显式配置仍优先。迁移需要可写的 settings 服务和已注册的 DeepSeek Provider；缺少它们时报明确信息，不忽略原连接。

默认搜索共用 DeepSeek Provider 的凭据引用。不同于聊天的旧搜索凭据作为 Provider 内部覆盖保留，不要求用户重新输入；literal key 按 secret schema 脱敏。新保存动作不向搜索策略 namespace 写密钥。

## 结果与错误

DeepSeek 继续发送 Anthropic-compatible Messages 请求和 `web_search_20250305`，解析结构化搜索结果及 citation 摘要。GPT 发送 Responses 请求和 `tools: [{type: 'web_search'}]`，解析完成的 search call sources 与 URL annotations。两者统一返回 `WebSearchResult.sources`，不把生成答案写入 `content`；web 服务负责最终 `maxResults` 截断。

发现 URL 后，Agent 继续调用 `web_fetch` 获取原文。工具结果与调用日志保持现有结构，证据映射沿用 search/fetch provenance 校验；本插件不创建证据或解释供应商数据以外的业务字段。

缺少搜索能力时报 `UNSUPPORTED_CAPABILITY`；GPT 不兼容的 Responses 端点时报 `UNSUPPORTED_RESPONSES_API`；无效或未完成的搜索结果时报 `WEB_PROVIDER_ERROR`。取消沿调用信号传播，HTTP 重定向在联系目标前被拒绝。错误包含 Provider 信息，不回显认证头或实际密钥。

## Model Experience

### What the model sees

辅助模型接收 `Perform a web search for the query: <query>` 和 Provider 所需的 hosted 工具定义。会话模型通过原 `web_search` 工具收到 URL、标题、日期和有来源的摘要；不会将辅助模型的生成答案当作网页原文。

### Token effect

每次搜索产生独立模型请求和服务端检索成本；`maxUses` 限制搜索次数。结果仍受 web 服务的来源数限制。

### KV Cache effect

搜索请求独立于会话缓存；工具结果按原调用链追加到会话上下文，不修改已有消息。

## Request logging

Agent 内的搜索在发送前追加 `web/provider-search-llm-request`，保存 Provider、解析后的端点、可选协议版本和实际 JSON 请求体。认证头与密钥不进入事件。旧 `web/deepseek-search-llm-request` 类型保留以读取既有会话日志。直接在 Agent 外调用时没有关联会话。

## Known Limitations and Deferred Work

能力目录表示已安装实现，不探测远端账号或网关授权。兼容服务可能拒绝 hosted search，此时错误直接返回。旧配置迁移采用两个 namespace 的先写后删，不提供跨 namespace 事务；中断后可安全重试。旧静态组合在只读部署中需要由部署方将连接字段移动到 Provider。
