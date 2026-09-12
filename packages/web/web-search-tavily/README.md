# `@deepseek-ai/dsh-web-search-tavily`

Tavily 搜索提供方。它向通用 `ctx.web` 注册 `tavily`，不依赖聊天模型 Provider，也不直接注册模型工具；`@deepseek-ai/dsh-tool-web` 仍是 `web_search` 的唯一模型入口。

API Key 不进入插件配置。`apiKeyEnv` 保存 Credentials 引用名，默认 `TAVILY_API_KEY`；每次搜索先通过 Credentials 服务解析，未挂载该服务时才读取启动环境。Settings 更新从下一次请求生效，密钥不会写入 session、Prompt 或项目产物。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `TAVILY_API_KEY` | Credentials 引用名或启动环境变量名。 |
| `baseURL` | `https://api.tavily.com` | API 根地址；提供方追加 `/search`。只接受不含凭据、查询或 fragment 的 HTTP(S) URL。 |
| `timeoutMs` | `30000` | 单次 Provider 请求的超时上限。 |
| `searchDepth` | `basic` | `basic`、`advanced`、`fast` 或 `ultra-fast`。 |
| `topic` | `general` | `general`、`news` 或 `finance`。 |
| `includeAnswer` | `false` | 是否请求摘要答案，也可设为 `basic` 或 `advanced`。 |
| `maxResults` | 未设置 | 调用方未传 `maxResults` 时采用的结果数，范围 1–20。 |
| `chunksPerSource` | 未设置 | 每个来源的片段数，范围 1–3；只可与 `advanced` 深度一起使用。 |

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: tavily

- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
    timeoutMs: 30000
```

请求映射到 Tavily `POST /search`，并固定关闭 raw content。响应的 `answer` 映射为通用 `content`，`results[].content` 映射为 `snippet`，URL、标题和发布日期保留在通用来源结构中。调用方的 `maxResults` 优先于配置默认值。

网络、HTTP、认证和响应解析失败返回 `WEB_PROVIDER_ERROR`；调用方取消返回 `WEB_ABORTED`；Provider 自身超时返回 `WEB_SEARCH_TIMEOUT`。缺少凭据也明确失败，不会改用聊天模型知识或其他搜索路由。

## Model Experience

Indirectly, through `dsh-tool-web`, which renders normalized Tavily answers and sources or the provider error.

#### KV Cache effect

无直接影响；请求前缀与结果呈现由 `dsh-tool-web` 管理。

## Known Limitations and Deferred Work

- 仅暴露通用搜索所需的稳定参数；域名、日期和国家过滤等待通用 Web Service 定义相应字段。
- `include_raw_content` 固定为 `false`；完整网页正文由后续 `web_fetch` 获取。
