# 面板报"无法连接到 dsh 主进程"(HTTP 405):通道注册被 cordis 服务解析静默吞掉

## 症状

- 侧边栏 footer 的"工作区文件夹"面板能打开，但每次请求都显示"无法连接到 dsh 主进程。(transport failure for /multi-root-workspace/list: HTTP 405)"。
- 宿主半部其余功能正常：`/workspace-folders` 命令可用、根登记可以落盘。
- 运行中的 web 服务日志里**没有**任何与插件相关的报错——失败被 cordis 的 fiber 错误处理静默吞掉。

## 根本原因

浏览器端的请求本身没有问题：`connection.rpc.call` 发出 `POST {origin}/multi-root-workspace/list`，宿主 rpc-host 按 `kind: 'prefix'` 前缀路由 + POST 接收，两侧协议完全一致。整个服务路径上唯一产生 405 的是 **frontend-static 的 SPA 回退**（上游 `packages/host/frontend-static/src/index.ts`：未命中任何命名路由的非 GET/HEAD 请求一律 405）——405 因此是"**宿主路由表里没有 `/multi-root-workspace` 前缀路由**"的铁证。

路由缺失的根因在 cordis 的属性访问纪律。`HostConnectionService.register()`（上游 `packages/client/connection/src/rpc-host.ts`）内部以属性访问读取 `owner.webServer.register(route)`，而 cordis v4 的属性访问只能解析到**读取服务的上下文自己的 fiber store 或其祖先 fiber**；兄弟行提供的 `webServer` 永远不在可见链上。唯一的例外是当读取服务的上下文本身是**根 fiber**（无 runtime）时，改走共享服务 store。

于是：

- 上游连接测试从根 ctx 调用 `rpc.handle` → 走共享 store → 通过；
- 本插件从嵌套 `ctx.inject(['connection'], …)` 回调里读取服务 → 属性解析从 connection 行自己的 fiber 沿祖先链上爬 → 找不到 `webServer` → 抛 `cannot get property "webServer" without inject` → 嵌套 fiber FAILED → 通道从未注册。

失败被 fiber 的 `logger.error` 吞进日志深处（`dsh web` 的 stdout 完全不可见），这就是 M3 验证没有发现的原因：当时所有断言都是进程内事实（命令可执行、`ctx.get('connection')` 存在、client bundle 被服务），**浏览器 → HTTP → 通道这一跳没有任何测试覆盖**。

## 诊断方法

1. 区分 401 与 405（一步定位）：

   ```bash
   curl -i -X POST http://127.0.0.1:<port>/multi-root-workspace/list \
     -H 'content-type: application/json' -d '{}'
   ```

   返回 **401** = 路由存在（只是 curl 没带浏览器 cookie）；返回 **405** = 路由缺失（通道未注册）。对照 `POST /api/任意路径` 应为 401，证明 `/api` 前缀路由活着。
2. 确认行本身活着：带 cookie 请求 `/api/pluginInventory/list`（信封 `{ type: 'client-request', rpcId, method: 'pluginInventory/list', payload: { args: {} } }`），检查 `multi-root-command` 的 `fiberPhase`。
3. 捕获被吞的错误：进程内 boot 后遍历 registry 的 fiber，找 `inject` 含 `connection` 且 `state` 为 FAILED 的 fiber，读其 `_error`。

## 已验证的解决方案

1. 嵌套 inject 同时声明 `['connection', 'webServer']`，让回调只在路由表存在后运行；
2. 在回调里改用 `connectionCtx.root.get('connection')` 读取服务——根 fiber 上下文的属性解析走共享服务 store，`rpc.handle` 内部的 `owner.webServer` 因此可解析，通道前缀路由成功挂载；
3. `connection === undefined` 的分支不再静默返回，打 `logger.warn`。

回归防护：`scripts/smoke-journey.mjs` web 腿对绑定端口发**真实 HTTP**：未认证 POST 必须是 401（而非 SPA 回退的 405），带 cookie 的 `list` 必须是 200 且返回含主根与附加根的 ok 信封。

## 波及面备注

上游插件 `@dsh-electron/dsh-plugin-git` 的 `/git` 通道用了与修复前完全相同的调用形态（嵌套 `ctx.inject(['connection'])` + `connectionCtx.connection.rpc.handle`），在真实 web 组合中预期存在同样的问题——升级该插件或上游修正 `rpc-host` 时应回头核对。
