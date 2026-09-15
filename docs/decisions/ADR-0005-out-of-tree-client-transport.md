# ADR-0005: 出树 client 半部的通道与落点

## Status

Accepted

## Date

2026-09-12

## Context

M3 要给插件加浏览器半部（Workspace Folders 面板），它必须和 host 半部交换数据。架构文档 §7 原先设想用 Typert 远程命名空间 `multiRootWorkspace`，并接入 `sidebar.workspaces.directoryFlow` 两个 picker 洞。实施前实测否掉了这两条：

1. **Typert 契约生成不支持出树包**：`@deepseek-ai/dsh-typert-generator` 虽是公开包，但它的分析器以 workspace 为单位——向上寻找 `tsconfig.host.json`，且只接受 `<root>/packages` 下的工程引用；同时要求包自己的 manifest 预先声明 `./typert` / `./remote` 导出与 `files`。出树单包仓库跑不通这条流水线。
2. **client 侧 remote 清单是上游静态表**：`@deepseek-ai/dsh-api-remotes/client` 按固定列表 `$mount` 各贡献（15 个第一方命名空间），出树插件的命名空间不在其中；`ctx.remote.$mount` 虽可在运行时挂载任意贡献，但前提仍是"有生成好的贡献制品"。
3. **两个 picker 洞是"创建工作区"流程的洞**：`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` 都是 `single` kind，owner（ui-workspace）收到路径后调用 `createWorkspace`，默认组合已被 `host-directory-picker-auto` 选出的 native/browse client 半部占满。插件占用它们既冲突又语义错误。
4. **两个受支持运行时的 slot 面不同**：pin 的 `0.1.5-rc.2` 有 `sidebar.panellist`（list）与 keyed `main` 面板；已安装的桌面运行时 `0.1.2-rc.1` 只有 `sidebar.brand.*` / `sidebar.workspaces` / `sidebar.settings` / `sidebar.footer.action`。`sidebar.workspaces` 是 `single` 且已被 WorkspaceBrowser 占用，不能"加一项"。
5. **公开且两版都有的通道确实存在**：Connection RPC——host 侧 `ctx.connection.rpc.handle(channel, handler)`，client 侧 `connection.rpc.call(channel, endpoint, payload)`。已发布的外部插件 `@dsh-electron/dsh-plugin-git@0.2.0` 用的就是它；`0.1.5-rc.2` 与 `0.1.2-rc.1` 都提供该 API。

## Decision

1. **通道 = Connection RPC 通道**，channel 固定 `/multi-root-workspace`，端点为 `list` / `add` / `remove` / `alias` / `move` / `reveal`。host 侧只在组合里同时存在 `connection` 与 `webServer` 时挂载（软注入），且服务必须从**根上下文**读取——cordis 的属性访问从插件 fiber 只能看到该 fiber 自己注入的服务，`rpc.handle` 内部解析 `webServer` 需要共享服务 store（详见 [故障排查：面板 HTTP 405](../troubleshooting/panel-channel-http-405.md)）；client 侧通过 `ctx.get('connection')` 取用。**不使用 Typert 远程命名空间**：它的契约生成与 client 装配都要求上游参与，出树形态下会退化成本地手写 wire 描述符，违反 ADR-0002 的"只依赖公开面"。
2. **面板落点 = `sidebar.footer.action`（list/root）+ 自绘对话框**。理由是两个运行时的交集只有一个 additive 的侧栏座位；面板是纯 React 组件，不引组件库、不新增 CSS 管线，因此不需要与宿主共享任何运行时身份。`sidebar.panellist` + `main` 的"全屏面板"升级留待只支持 0.1.5 时再做。（样式机制后续由 [ADR-0006](./ADR-0006-client-ui-host-tokens.md) 修订：内联样式改为注入样式表、消费宿主 `--dsw-*` token。）
3. **目录选择复用上游已组合的能力，而不是自己占洞**：命令侧（host）在 `directoryPicker` seam 存在且 capability 为 `native` 时直接 `pick(signal)`；面板侧调用 `ctx.uiWorkspace.pickDirectory()`（上游自己的入口，会正确选择 native 或 browse）。seam 或服务缺失时，命令返回明确错误、面板降级为手输绝对路径。
4. **主根由客户端指名、host 校验**（已被 [ADR-0008](./ADR-0008-panel-session-derived-authority.md) 取代）：面板把当前会话 id（来自 client Session Controller，读不到时留空）与可选的主根路径一起发给 host；host 优先用客户端给的路径（必须是已存在的目录），否则用会话 header cwd，最后回落到 `sandboxPolicy.resolve()`。面板顶部始终显示它正在管理哪个主根。**现行规则**：请求只带必填 `sessionId`，host 用 `resolvePanelPrimaryRoot` 从该 session 的 cwd 推导主根；没有 `primaryRoot` 字段，也没有部署默认回退。
5. **失败按 code 本地化**：通道返回 `{ ok: true, value } | { ok: false, error: { code, message, details } }`，code 取自根词汇表（`not-absolute`/`missing`/`duplicate`/`nested`/…）；面板按 code 查自己的双语词典，host 的 message 只作兜底。
6. **client 制品的形状照抄上游模块加载器协议**：CJS 闭包工厂（`window.__ModuleLoader__.load({ id, factory: (require) => … })`）、`exports.apply` / `exports.inject`、外部依赖只允许两个运行时都 seed 的平台词（react / react-dom / cordis / client-store / ui-slots / ui-primitives），其余全部内联。build 由本仓库自己的 tsdown 双配置完成（上游的 `clientBundle` preset 未发布且以 monorepo 布局为前提）。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| Typert 远程命名空间（生成 `/typert` + `/remote`） | 生成器以 workspace 为分析单位、只认 `<root>/packages` 下的工程；client 侧还要自己 `$mount`，出树形态下等于手写 wire 契约（违反 ADR-0002） |
| 在 profile 里 patch 上游 `api-remotes` 的静态清单 | 需要改上游包或复制其 client 装配，等于把"不修改上游"这条硬约束绕过去 |
| 占用 `sidebar.workspaces.directoryFlow` 两个洞 | 它们是"创建工作区"的 `single` 洞，默认组合已有占用者；占用会冲突，且 owner 会把选中的目录当成新工作区 |
| 只做 host 半部（不做 UI） | 需求验收 §9 要求 Folders 列表与 Add/Remove/Alias/Reveal；命令能满足文本面，但"UI"是第一期范围 |
| 面板改用 `sidebar.panellist` + `main` | 0.1.5 才有，会丢掉已安装桌面运行时 `0.1.2-rc.1` 的兼容（M1/M2 一直保持双运行时验证） |
| 面板通过自建 HTTP 路由 + `fetch` 取数 | 需要依赖 shell 的 `__DSH_TRANSPORT__` 内部全局与路由信任细节，属于非公开缝；Connection 通道已经把这一切做完了 |
| 让 host 半部直接调 `directoryPicker` 的 `pick` 给面板用 | `pick` 是 host 显示器上的 OS 选择器，远程浏览器场景会弹在错误的那台机器上；browse capability 才是远端形态，而那是客户端对话框 |

## Consequences

- 面板与 host 之间是一份**本地契约**（`src/contract.ts`），双方各自编译、客户端内联。上游若将来提供出树的 remote 贡献注册表，迁移路径是"把 `command.ts` 里的 `rpc.handle` 换成 `TypertRemoteService` + 生成的 `/remote`，客户端换成 `ctx.remote.$mount`"，面板组件与端点语义不变。
- 面板只在组合里有 `connection`（web profile）时出现；headless 上该行仍然挂载，但只注册命令。
- 通道注册的调用形态是硬约束：嵌套 inject 必须同时声明 `connection` 与 `webServer`，服务必须经 `ctx.root` 读取。违反时不报显眼错误，只表现为面板一律 HTTP 405（见 Related Documents 的故障排查记录）；上游连接测试从根 ctx 调用，所以该坑在测试面不可见。
- Connection 通道的授权就是浏览器的 loopback/Host/Origin 信任栅栏（无令牌）；这与上游所有 client 插件一致，插件不额外引入鉴权。
- client 半部因此必须自带双语词典与自己的词典 parity 测试（上游的 i18n 门禁只扫它自己的目录）。

## Related Documents

- [M3 开发计划](../plans/completed/2026-09-12-m3-root-registry-command-and-ui.md)
- [架构文档 §7](../architecture/multi-root-workspace.md)
- [ADR-0002 上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
- [开发流程 §7](../development/plugin-development-workflow.md)
- [故障排查：面板 HTTP 405](../troubleshooting/panel-channel-http-405.md)
