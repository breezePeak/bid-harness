/** 适配器与应用回归共用的合成 Responses 流，不访问外部 Provider。 */
import { createServer } from 'node:http'

/** Responses 提供方在完成事件前断开的原始错误。 */
export const responsesDisconnectMessage = 'stream disconnected before completion: stream closed before response.completed'

/**
 * 合成 Responses 流：失败尝试包含完整工具块，但缺少成功的响应终点。
 * @param failed 是否返回断流错误而非正常完成。
 * @returns 本地 HTTP 提供方逐条发送的 SSE JSON 数据。
 */
export function responsesRetryEvents(failed: boolean): string[] {
  const text = failed ? 'DISCARD_FAILED_RESPONSE' : 'RESPONSES_RETRY_OK'
  const item = {
    type: 'message', id: 'msg-synthetic', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  const events: unknown[] = [
    { type: 'response.created', response: { id: 'resp-synthetic' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
  ]
  if (failed) {
    const call = {
      type: 'function_call', id: 'fc-synthetic', call_id: 'call-synthetic', name: 'write',
      arguments: JSON.stringify({ path: 'failed-response.txt', content: 'must not execute' }),
    }
    events.push(
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: call.arguments },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'error', code: 'stream_error', message: responsesDisconnectMessage },
    )
  } else {
    events.push({
      type: 'response.completed',
      response: {
        id: 'resp-synthetic', status: 'completed', output: [item],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    })
  }
  return events.map(event => JSON.stringify(event))
}

/** 一次断流后成功的本地服务，以及调用方拥有的关闭操作。 */
export interface ResponsesRetryServer {
  readonly url: string
  readonly paths: readonly string[]
  readonly requests: readonly unknown[]
  /** 等待此夹具的 HTTP 服务关闭。 */
  close(): Promise<void>
}

/**
 * 开启先失败、后成功的合成 Responses 服务，保留实际请求以核对重试。
 * @returns 调用方必须在 finally 中关闭的本地服务。
 */
export async function responsesRetryServer(): Promise<ResponsesRetryServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      paths.push(request.url ?? '')
      requests.push(JSON.parse(body) as unknown)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(responsesRetryEvents(requests.length === 1).map(event => `data: ${event}\n\n`).join(''))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Responses 本地服务未分配端口。')
  return {
    url: `http://127.0.0.1:${address.port}`, paths, requests,
    close: () => new Promise((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })),
  }
}
