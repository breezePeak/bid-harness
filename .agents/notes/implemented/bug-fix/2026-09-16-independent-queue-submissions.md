# Agent Note: 普通队列提交保持独立受理

Status: implemented

## Problem

普通提交已经在输入层完成本地交接，但会话服务仍用同一个队列尾等待前一条 `sendSession` 完成。该等待覆盖图片准备和 Host 受理，任一阶段不结束都会让后续消息无法进入 `Session.prompt`，重新形成发送卡住的共享锁。

## Decision

`ConversationController.sendSession` 为每条提交直接启动独立的准备与 Host 受理流程，不在客户端按会话维护共享队列尾。队列状态和最终投递顺序由 Host 的 `session.prompt` 及其 inbox 负责；客户端只用 `clientSubmissionId` 维护每条本地 outgoing 行与正式消息的交接关系。

## Alternatives considered

**继续保留会话级队列尾。** 否决：它把后续消息绑定到前一条请求的图片准备、引用准备或受理回执，违背普通提交独立交接的生命周期。

**给共享队列尾增加固定超时。** 否决：超时只能把永久卡住改成任意延迟，仍会阻塞后续消息，也无法判断前一条请求是否已在 Host 端成功受理。

**由客户端维护完整队列并替代 Host inbox。** 否决：会话切换、重连和多客户端会产生第二个队列事实来源；Host inbox 仍是队列状态的权威来源。

## Consequences

同一会话的普通消息可以并行完成本地准备和 Host 受理，慢请求不会阻塞后续输入；每条 outgoing 行仍通过独立身份处理成功、失败、断链和正式消息交接。并发请求到达 Host 的顺序由传输与 Host 受理决定，客户端不再用等待尾人为其排序。
