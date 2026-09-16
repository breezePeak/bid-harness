/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchProvider' | 'webSearchProviderHint' | 'webSearchFollowModel'
  | 'webSearchUnavailable' | 'webSearchProviderError'
  | 'webSearchIndependentTitle' | 'webSearchIndependentHint'
  | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'tavilyApiKey' | 'tavilyApiKeyHint' | 'tavilyApiKeyRef'
  | 'tavilyApiKeySet' | 'tavilyApiKeyUnset' | 'tavilyBaseUrl' | 'tavilyBaseUrlHint'
  | 'tavilyTimeoutMs' | 'tavilyTimeoutMsHint' | 'tavilySearchDepth' | 'tavilySearchDepthHint'
  | 'tavilyTopic' | 'tavilyTopicHint' | 'tavilyIncludeAnswer' | 'tavilyIncludeAnswerHint'
  | 'tavilyMaxResults' | 'tavilyMaxResultsHint' | 'tavilyChunksPerSource' | 'tavilyChunksPerSourceHint'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  configurableTab: 'Plugin configuration',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'Follow the current model provider by default, or select an independently configured web search provider.',
  webSearchProvider: 'Web search provider',
  webSearchProviderHint: 'Choose whether searches follow the current model provider or use an independent provider configured below.',
  webSearchFollowModel: 'Follow model provider',
  webSearchUnavailable: 'unavailable',
  webSearchProviderError: 'Unable to read Web search providers.',
  webSearchIndependentTitle: 'Independent web search',
  webSearchIndependentHint: 'Configure the independent provider offered by the selector above. Its settings are retained while model-provider search is selected.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'Search budget used when web search follows the model provider.',
  tavilyApiKey: 'API key',
  tavilyApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  tavilyApiKeyRef: 'Credential reference',
  tavilyApiKeySet: 'A key is configured.',
  tavilyApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  tavilyBaseUrl: 'Endpoint',
  tavilyBaseUrlHint: 'HTTP(S) API root; /search is appended.',
  tavilyTimeoutMs: 'Request timeout (ms)',
  tavilyTimeoutMsHint: 'Maximum time allowed for one independent search request.',
  tavilySearchDepth: 'Search depth',
  tavilySearchDepthHint: 'Basic is faster; advanced keeps more retrieval detail.',
  tavilyTopic: 'Topic',
  tavilyTopicHint: 'The independent provider result category.',
  tavilyIncludeAnswer: 'Generated answer',
  tavilyIncludeAnswerHint: 'Whether the independent provider should return an answer summary.',
  tavilyMaxResults: 'Default result count',
  tavilyMaxResultsHint: 'Used when the web search request does not specify a result count.',
  tavilyChunksPerSource: 'Chunks per source',
  tavilyChunksPerSourceHint: 'Only valid with advanced search depth.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '插件',
  title: '插件',
  intro: '配置和查看本部署已安装的插件。',
  tabs: '插件视图',
  configurableTab: '插件配置',
  empty: '本部署没有开放任何插件设置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  webSearchTitle: '网页搜索',
  webSearchDescription: '默认跟随当前任务的模型 Provider；也可选择下方配置的独立网页搜索 Provider。',
  webSearchProvider: '网页搜索提供方',
  webSearchProviderHint: '选择跟随当前模型 Provider，或使用下方已配置的独立搜索 Provider。',
  webSearchFollowModel: '跟随模型 Provider',
  webSearchUnavailable: '不可用',
  webSearchProviderError: '读取网页搜索 Provider 失败。',
  webSearchIndependentTitle: '独立 Web Search',
  webSearchIndependentHint: '配置上方下拉框可选的独立搜索 Provider；选择跟随模型时保留这些配置。',
  webSearchMaxUses: '单次请求最多搜索次数',
  webSearchMaxUsesHint: '跟随模型 Provider 搜索时，一次请求最多可以搜索多少次。',
  tavilyApiKey: 'API Key',
  tavilyApiKeyHint: '密钥不会写入设置文件。留空表示保留当前密钥。',
  tavilyApiKeyRef: '凭据引用',
  tavilyApiKeySet: '已配置密钥。',
  tavilyApiKeyUnset: '未配置密钥；配置前搜索不可用。',
  tavilyBaseUrl: '接口地址',
  tavilyBaseUrlHint: 'HTTP(S) API 根地址；系统会追加 /search。',
  tavilyTimeoutMs: '请求超时（毫秒）',
  tavilyTimeoutMsHint: '单次独立搜索请求允许的最长时间。',
  tavilySearchDepth: '搜索深度',
  tavilySearchDepthHint: 'basic 更快；advanced 保留更多检索细节。',
  tavilyTopic: '主题',
  tavilyTopicHint: '独立搜索 Provider 返回结果的分类。',
  tavilyIncludeAnswer: '生成答案',
  tavilyIncludeAnswerHint: '是否让独立搜索 Provider 返回答案摘要。',
  tavilyMaxResults: '默认结果数',
  tavilyMaxResultsHint: 'Web 搜索请求未指定结果数时使用。',
  tavilyChunksPerSource: '每个来源的片段数',
  tavilyChunksPerSourceHint: '只有搜索深度为 advanced 时有效。',
}
