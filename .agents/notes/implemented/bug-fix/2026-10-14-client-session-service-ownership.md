# Agent Note: 客户端 Context 的会话服务归属

Status: implemented

## Problem

Host 与 Client 在各自的 TypeScript 程序中声明同名 `ctx.sessions`，分别由 SessionStore 和 ISessions 提供。客户端功能引用公共 Host 契约时，类型分析器可能把 Host 的服务声明带入客户端程序；仅以 Context 别名表达 ClientContext 会使会话作用域调用被误判为 SessionStore 的成员。

## Decision

ClientContext 明确声明其会话服务为客户端 ISessions，实际服务注册、作用域创建及方法实现保持所属插件的职责。客户端功能通过这个正式接口读取会话，不为业务调用增加转换、回退或规则豁免。

## Alternatives considered

**逐处转换会话服务类型。** 多处调用仍共享同一个服务，分散转换会隐藏错误归属，并使新的调用重复承担类型约束。

**关闭类型感知规范检查。** 会话作用域影响 Remote 调用的归属，必须保留服务接口及非法调用的静态拒绝。

## Consequences

客户端聚合程序和类型感知 lint 使用同一会话服务接口；类型回归验证 ISessions 及作用域能力，现有作用域行为测试继续验证实际服务。Host 保留其独立 SessionStore 声明，ClientContext 不暴露 Host 的会话存储方法。
