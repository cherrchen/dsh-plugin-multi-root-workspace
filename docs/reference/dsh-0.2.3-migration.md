# DSH 0.2.3 接口与安全契约审查

2026-11-22 对上游发布 tag 做只读源码对照；发布包行为另由本仓库测试与真实 Host 证据验证，执行状态只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。不修改上游 checkout，也不深导入其内部源码。

| tag | commit | 发布提交 | npm dist-tag |
|---|---|---|---|
| `dsh-v0.2.2-rc.5` | `9c2670d3bce5275e0d1610272958121af87787bb` | `9bf478edde5b14e6a15d3802a8834bdca83f2d97` | `next` / `latest` |
| `dsh-v0.2.3-alpha.1` | `d98f5d68519215da48f3002da2cb9c9d2068d81d` | `aae91d692e2802f63a4a92fd073fe21259795e59` | —（发布不可启动，仅源码对照） |
| `dsh-v0.2.3-alpha.2` | `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` | `267805d20d` | `alpha` |

## 发布边界

`alpha.1` 是 `0.2.2-rc.5` 的后代，中间合入四天的主线开发；`alpha.2` 只在 `alpha.1` 之上替换包版本号，另有 **3 个 `src` 行级变化**：

- `packages/boot/app-boot/src/profile-resolution/resolver.ts`；
- `packages/boot/hmr/src/package-manifest.ts`；
- `packages/ptc-runtime/ptc-runtime-node/src/imports/vm-modules.ts`。

这 3 处都不在插件消费的具体接缝上，因此**服务端接缝的所有差异都是 `rc.5 → alpha.1` 的差异，`alpha.2` 与 `alpha.1` 共用一份适配**。注意 `alpha.1` 发布的 vendor pin 未同步，发布包无法启动，只有 `alpha.2` 进入支持合同（见下节）。`alpha.2` 独有的变化是根 `engines`：从 `>=24.9.0` 改为 `^24.22.3 || >=26.13.1`（上游升级指南 `docs/upgrade-guide/v0.2.3-alpha.1/node-24-22-3/guide.md` 说明这是首个内置 November 2026 undici 安全修复的 Node 24/26 版本线）。

## 为什么只纳入 `alpha.2`

`0.2.3-alpha.1` 的源码已经迁移到 cordis 4.2 的 `Context.root` 与 loader 1.2 的 `EntryValidationError`，但发布提交没有同步 vendor pin：npm 发布的 `@deepseek-ai/dsh@0.2.3-alpha.1` 仍声明 cordis `~4.1.0` / loader `~1.1.0`。在空目录安装该精确版本后直接运行 `dsh --version` 即崩溃：

```
SyntaxError: The requested module '@deepseek-ai/cordis-plugin-loader' does not provide an export named 'EntryValidationError'
```

CI 的 alpha.1 lane 另有 typert `ctx[Context.root].reflect` 未定义等 125 个失败；`alpha.2` 补上 vendor `4.2.0-alpha.1` / loader `1.2.0-alpha.1` 后 `dsh --version` 正常输出 `0.2.3-alpha.2`。因此 alpha.1 只作为源码对照（用来解释接缝来源），不进入 `SUPPORTED_DSH_RELEASES`、peer range、Auto Review 联合集合、SSH 地板或 CI 车道。

## 接口差异逐项分类

下列源码路径均相对上游仓库。

| 接缝 / 上游源码 | 变化 | 分类与插件处理 |
|---|---|---|
| `dsh-sandbox-policy` `src/index.ts` | `resolve({session}).workspaceRoot` 从 `session.header.cwd` 改为 `ctx.get('workingDirectory')?.get(session) ?? session.header.cwd`（有效工作目录）；文档注释同步改写。**这是本轮唯一安全相关差异。** | **运行时适配（安全）**：插件 ADR-0012 的不变量是「身份 = Session 原始项目；有效 cwd 只作相对路径/展示」。上游打破了 `workspaceRoot === header.cwd` 的旧等式，于是所有 Registry/scope 身份改用显式原始目录（`src/compat/session-directory.ts` 的 `originDirectory` / `policyOriginRoot`），而 `policy.workspaceRoot` 继续作为上游执行边界（`src/sandbox.ts` / `src/dialects.ts` 不变）。否则 Host 移动 Session 目录后按有效拼写查 scope 表会得到空集：登记为 `read-only` 的附加根在 `workspace-write` 下可能被当作可写、`toolAccess` 上限被绕过，指令还会发出虚假撤销。回归测试覆盖「移动到只读附加根内后写仍被拒」。 |
| `dsh-working-directory` `src/*` | 事件从 `working-directory/change` 改为 `workspace-root/change`，stateVersion 升到 3；旧事件名称废弃并被忽略。 | **运行时适配**：`src/compat/instruction-activity.ts` 的 resume 重放同时接受两种事件名（优先新名），否则恢复后会按过期 cwd 解析相对目标。 |
| `@deepseek-ai/cordis` 4.2.0-alpha.1 | 删除 `ctx.root` 属性，根上下文改由发布的 `Context.root` 符号（`Symbol.for('cordis.root')`）承载；`FiberState` 仍是 const enum（无运行时导出）。 | **运行时适配（可选 Auto Review）**：`src/compat/cordis-root.ts` 结构化探测两种 API（先符号、后 `root` 属性、都不存在则失败关闭）；`current/fork.ts` 的卸载分支改用该探测。真实宿主的 cordis 版本是：`alpha.1` 声明 `~4.1.0` 因而安装 **4.1.0（只有 `ctx.root`）**，`alpha.2` 安装 **4.2.0-alpha.1（只有符号）**——单一拼写必然在另一侧失效，故两种都探。`peerDependencies.cordis` 追加 `4.2.0-alpha.1`。 |
| `packages/experimental/auto-review/src/index.ts` | 与 `rc.5` 相比只有两行：import 顺序，以及 `ctx.root.fiber.state` → `ctx[Context.root].fiber.state`；`locales.ts` 逐字节不变。`alpha.1` 与 `alpha.2` 的 reviewer `src` 树逐字节相同（alpha.1 仅作源码对照；tree `9178184679…`，`index.ts` blob `3513c23f66`，sha256 `179e8f50…`）。 | **运行时适配（联合合同）**：两行都在 `current/fork.patch` 已替换的行内，输入模型未变，因此不新增第三个源码代际；`AUTO_REVIEW_CURRENT_RELEASES` 追加受支持的 alpha.2（联合集合 11 → **12** 个精确发布），编译 pin 前移到 `0.2.3-alpha.2`。冻结副本保持 `rc.5` 字节（8 个发布里 7 个逐字节命中），审计差异就是这两行；差分门禁新增断言：fork 必须经 `rootContext` 探测、不得直接拼任一 cordis 根 API。 |
| `dsh-api-session-controller` 新增 `src/client/sessions/directories.ts` 与 `./client/directories` 导出 | `selectSessionDirectory(state, id)` = 投影的 `workingDirectory` ?? 头部 cwd；`sessionDirectory(sessions, id)` 在 gesture 时读 live 投影。文件视图、地址基与相对路径改用有效目录；头部 cwd 仍是项目身份。 | **客户端语义跟随**：插件的附加根树根永远是 RootSwitcher 选中的根或 `rootForPath` 结果，不从该选择器推导；但原生主根标签/路径显示应使用同一有效目录语义（插件已有的 `RootsView.effectiveCwd` 字段即此用途），Registry 键保持 `primaryRoot`。不得静态 import 新子路径（旧宿主没有该模块，整个 client bundle 会加载失败）；需要时结构化读取投影。 |
| `packages/client/ui-sidebar-files/src/client/*` | `FileNavigator` / `FilesBody` / `NavigatorToggle` 改用 `selectSessionDirectory`；`FilesBody` 把 `sidebar.right.tab.files.actions` 包进新的 `div.externalActions` 并配套 header 对齐 CSS；`FilesBody.module.css` 的 covered 规则改成自定义属性（避免 Chromium 整页重排）、header 补 13.5px padding 与 16px 图标；`FileTree.module.css` 层级缩进改 `calc(16px + 6px)`；`face.ts` 支持 hold 期间目录变化后按新目录重跑搜索。 | **客户端复刻同步**：`src/client/styles.ts` 同步层级缩进与 `mrfw-open*` 规则；新增 `data-files-page` 下 `div.externalActions` 的 unwrap 规则（用 `:not(:has(> [data-files-path))` 区分新包装与旧直接子节点），否则附加根态 RootSwitcher 不再是 header 的伸缩项、原生 reload/search 与路径错位。插件 pane 是 portal 进 `data-files-page` / `aside[data-files-navigator]`，不复制上游 covered 变量规则（aside 本身即被该规则排除的 `.navigator` 子节点）。 |
| `packages/client/ui-open-in-app/src/client/*` | `controller.ts` 的 `readAppsPayload` 重构；`index.ts` / `context-menus.tsx` / `session-open-with.ts` / `open-path.ts` 变化；`OpenTargetButton.module.css` hover 进入 `@media (hover: hover)`、新增 compact 边框与最小宽度。 | **客户端复刻同步**：插件只 fork 目录控制所需的六个文件；`controller.ts` 与 `OpenTargetButton.module.css` 重拷 alpha.2 字节（语义不变），CSS 规则同步进 `styles.ts` 的 `mrfw-open*` 块；其余上游注册面不 fork。 |
| `dsh-client-connection` `src/*` | `HostConnectionService` 构造改为 `(ctx, trustedHosts)` 并引入 `connection.authentication`；HTTP 路由在 `peer === undefined` 时提前返回；公开 `rpc.handle/intercept` 与客户端 `rpc.call` 形状不变。**`ConnectionService.authenticatedUrl()` 移出**：登录 URL 改由新包 `@deepseek-ai/dsh-host-authentication-token` 通过 `webserver/entry-url` 事件贡献。 | **无产品源码适配**：插件面板走公开 Connection RPC 通道（ADR-0005），API 形状未变；测试夹具需要创建 Peer 并接入认证（`tests/skills-channel.spec.ts`），journey 冒烟改为优先用旧方法、否则从 `webserver/entry-url` 事件收集登录 URL。 |
| `dsh-app-boot` `src/profile-resolution/*`、`dsh-hmr` `src/package-manifest.ts` | profile patch 解析与 hmr manifest 变化。 | **测试夹具适配**：`tests/skills-settings.spec.ts` / `tests/ops-settings.spec.ts` 的 `bootProfile` 夹具补上 alpha.2 解析器要求的字段。 |
| `dsh-api-workspace-files` `src/index.ts` / `client/change-feed.ts` | live Session 的 `WorkspaceFileScope.workspaceRoot` 改为 sandbox policy 的有效根；stored Session 用 projection cache 的 `workingDirectory` ?? 头部 cwd；新增 `scopeOf()`（纯新增）；Remote 方法形状不变。 | **跟随第 1 行**：插件的 routing 以 Session 原始目录查 Registry/scope，路径基仍用请求里的 `workspaceRoot`；Remote 契约本身无破坏。 |
| `packages/bundle/base/cordis.patch.yml` | 新增 `deepseek-auth` / `cli-account` / `upstream-skills` 行；删除 `tool-working-directory` 行。 | **无适配**：插件 patch 只 disable `fs-sandbox` / `sandbox` 并插入自己的行，不引用这些 id。 |
| `dsh-session` / `dsh-api-session-controller` | 新 Session 的 `header.cwd` 在创建时 canonicalize（realpath 拼写）。 | **行为记录**：`primaryKey` 仍是词法拼写、不重新解析（ADR-0028）；新 Session 从此携带规范拼写，不影响既有记录。 |
| 其余接缝 | `dsh-fs` / `dsh-fs-local`（`brandString` 内部化、`patchText` / `deleteFile` / `moveFile` 形状不变）、`dsh-sandbox`（escalation 文档）、`dsh-sandbox-local` / `sandbox-windows-acl` / `fs-sandbox`（无 `src` 变化）、`dsh-storage-*`、`dsh-settings`、`dsh-subprocess`、`dsh-skill`（`TypeError` → `SkillError`）、`dsh-lsp`（去掉若干 re-export，插件走命名空间默认导入）、`dsh-llm`（`api-key` 导出移除，`createUserMessage` 等仍在）、`dsh-tools`、`dsh-agent`、`dsh-permission-presets`（新增 set Remote）、`dsh-commands`、`dsh-typert-protocol`（`RemoteError` 改继承 `HarnessError`，构造签名不变）、`dsh-system-prompt` / `dsh-session-query`（`inject` 变化，现有测试栈已满足） | **无影响**（逐接缝证据见本节与逐树核对）；会话格式仍为 4。 |

## 逐树核对（`rc.5 → alpha.2`，`git rev-parse <tag>:<path>`）

变化：`fs-local/src` `700a6e5ac9` → `9b50d98d22`；`sandbox/src` `01104584d8` → `4f678b29d0`；`sandbox-policy/src` `ec4a77eb6c` → `c8bd50194a`；`session/src` `d1aaa264d6` → `50a3aa9d38`；`session/working-directory/src` `1f72938a23` → `76cdb9852c`；`skill/src` `2c9c47d5ee` → `344f4c27f6`；`skill-filesystem/src` `bbd5a998e7` → `9d69c2a987`；`lsp/src` `6edec9f634` → `5436a1e908`；`lsp-stdio/src` `37b51c90c5` → `f2f07d4307`；`api/workspace-files/src` `55865100c9` → `e40b8ba9d2`；`experimental/auto-review/src` `2c4de92078` → `9178184679`；`client/ui-open-in-app/src/client` `3bed6f40cc` → `6b4a90b59d`；`client/ui-sidebar-files/src/client` `6cad50b5fd` → `0c199c941e`；`core/tools/src` `85fdc7658b` → `8781609698`；`core/agent/src` `e12358b3c4` → `e55453c525`；`core/system-prompt/src` `14fa82dab6` → `4b602ea0ce`；`interaction/commands/src` `b40e286329` → `5dd8df0ee3`；`interaction/permission-presets/src` `d6fe7f3b77` → `aaf300c7eb`；`llm/src` `13c5296093` → `8938288930`；`settings/src` `2c80a6f1cf` → `b636e51c17`；`api/session-controller/src` `28180f405a` → `8397c7d16a`；`session-query/src` `8553e7b8ae` → `03ed1a3dd4`；`typert/protocol/src` `a065d07fe1` → `6a6522dc21`；`client/connection/src` `a3c95ded8e` → `9de9ca7e3d`。

未变：`fs/src` `a2ead247d1`、`fs-sandbox/src` `178f100356`、`sandbox-local/src` `df462d3e5e`、`sandbox-windows-acl/src` `ceee0b85f1`、`session/session-projection/src` `7935938ee8`、`storage-domain/src` `3f84d317ea`、`subprocess/src`、`agent-instructions/src`，以及四个可选 SSH 包——`ssh/ssh/src` `ea33ac94f9`、`ssh/fs-ssh/src` `f9a7c29ec0`、`ssh/sandbox-ssh/src` `ca2401aace`、`ssh/subprocess-ssh/src` `495a4c6e65`，`rc.5` 与 `alpha.2` 指向同一树。

## 环境要求变化

`0.2.3-alpha.2` 起 root `engines` 为 `^24.22.3 || >=26.13.1`（`alpha.1` 仍是 `>=24.9.0`）。本仓库 CI 按发布分流：`0.1.*` / `0.2.0` / `0.2.1` 用 Node `22.19.0`，`0.2.2` 用 `24.9.0`，`0.2.3` 及以后用 `24.22.3`；开发树与 `release.yml` / `diag.yml` / upgrade 车道同步到 `24.22.3`。`dsh` 的 cordis 依赖从 `~4.1.0` 变为 `~4.2.0-alpha.1`，schemastery 从 `~3.19.0` 变为 `~3.20.0-alpha.1`；本插件 dev pin 与 peer 同步，`node-addon-system 0.1.2` / `koffi 3.1.1` 不变。

## 提升步骤（本分支已执行）

1. `node scripts/upgrade-dsh.mjs 0.2.3-alpha.2` 重指 devDependencies / release-age / 生态 pin；
2. `SUPPORTED_DSH_RELEASES` 末尾只加入 `0.2.3-alpha.2`（27 个精确版本；`0.2.3-alpha.1` 发布不可启动，不纳入），同步全部 DSH peer、`peerDependencies.cordis` 追加 `4.2.0-alpha.1`；移除 probe overrides 后 `pnpm install --no-frozen-lockfile`，最终 lockfile 中旧 `0.2.2-rc.5` 包副本为 0、`pnpm peers check` 输出 `No peer dependency issues found`；
3. Auto Review 联合合同：`AUTO_REVIEW_CURRENT_RELEASES` 加 `0.2.3-alpha.2`（12 个联合发布），编译 pin 前移到 `0.2.3-alpha.2`，新增 `src/compat/cordis-root.ts` 与差分门禁第 9 项；
4. `pnpm-workspace.yaml`：release-age 条目整体重指；`libreoffice-kit` `0.1.3` → `0.2.3`、`cordis-plugin-*` `1.1.0` / `1.2.0` → `1.2.0-alpha.1` / `1.3.0-alpha.1`、`cosmokit` `1.9.0` → `1.10.0-alpha.1`、schemastery 排除范围追加 `3.20.0-alpha.1`，并新增 17 个新传递包；
5. 安全适配：Session 原始目录成为所有 Registry/scope 身份来源（`src/compat/session-directory.ts` + `src/scope.ts` / `src/instructions.ts` / `src/review-context.ts` / `src/command.ts` / `src/workspace-files.ts` / `src/process-fence.ts`），并接受 `workspace-root/change`；
6. SSH 地板随核心 pin 前移：`SUPPORTED_SSH_RELEASES` 追加 `0.2.3-alpha.2`（保持 `SUPPORTED_DSH_RELEASES` 后缀），四个 SSH 可选 peer 的 range 随 27 个精确发布全量更新，SSH 开发 pin 跟随核心 pin 到 `0.2.3-alpha.2`；SSH 能力仍只在 macOS/Linux 开放且默认关闭，包缺席或漂移只让 SSH 缺席。SSH 参考、用户指南与门禁计划的当前地板同步到 alpha.2。
7. 更新 README 支持矩阵、`AGENTS.md` 兼容契约段、兼容笔记双语 `25、ADR-0012 修订、ADR-0040 修订五、路线账本与本文；`CHANGELOG` 条目随实际发版的发布流程写入，本分支不创建版本号或 tag。

## 安静陷阱（开发树）

- **Node 下限按发布分代**：`0.2.3-alpha.2` 起必须 `^24.22.3 || >=26.13.1`；CI 不能再用单一 24.9 车道覆盖整个 0.2.3 线，也不要在插件 `engines` 里写死上游下限——插件的运行下限由宿主决定。
- **Auto Review 的开发包清单由合同映射驱动**：`upgrade-dsh.mjs` 只在目标发布能映射到某个基线时安装该基线的 21 个开发包；先把 alpha 发布写进 `AUTO_REVIEW_CURRENT_RELEASES` 再重跑升级脚本，否则这些包会被当作「不属于当前基线」删除，安装树出现旧版本 peer 副本。
- **cordis root 有两种真实 API**：current Auto Review 基线横跨 `0.2.2` 行（cordis 4.1，只有 `ctx.root`）与受支持的 `0.2.3-alpha.2`（cordis 4.2，只有 `Context.root` 符号）；alpha.1 源码已改用符号，但它的发布包不能启动，不要照抄单侧写法，也不要新增第三个源码代际，结构化探测已覆盖两代。
- **身份与执行边界分离**：`policy.workspaceRoot` 现在是有效目录，只能作为上游执行边界和路径基；任何 Registry 键 / scope 表查找 / 面板 command 主根都必须用 `session.header.cwd`。按有效拼写查表会静默丢掉 deny 记录（安全回归），不是「只是找不到附加根」。
- **客户端复刻的 DOM 变化是包装层**：alpha.1 起 Files header 把 actions 槽包进 `div.externalActions`；插件的 `styles.ts` 规则必须用 `:not(:has(> [data-files-path))` 兼容旧直接子节点布局，不能假设槽锚点仍是 header 直接子节点。
- **不要静态 import 新客户端子路径** `@deepseek-ai/dsh-api-session-controller/client/directories`：旧宿主没有该导出，整个 client bundle 会加载失败；需要有效目录时读 `RootsView.effectiveCwd` 或结构化投影。
- **release-age 不是可选清单**：`alpha.2` 引入 17 个新传递包与新的 cordis 生态版本，漏一行会在启用发布年龄门禁的 frozen install 里被拒绝；`node-addon-system` / `schemastery` 等既有 pin 走各自条目，不重复添加。
- **tag 存在不等于可支持**：`0.2.3-alpha.1` 的源码与发布元数据不一致，`dsh --version` 直接失败。最小判别是在空目录 `npm install @deepseek-ai/dsh@<release>` 后运行 `dsh --version`；失败即只能作源码对照。
- **profileContext 必须同时携带两代 overlay 字段**：0.2.3 前的 `readProfilePatches()` 展开 `context.overlays`，0.2.3 之后展开 `context.overlayPaths`；in-process boot 夹具只给一个会让另一代在 `listPlugins()` / journey 中抛 `TypeError`。用 `scripts/lib/profile-context.mjs` 的共享 helper，并由 `tests/profile-context-fixtures.spec.ts` 守卫。
- **PTC 程序格式随版本变化**：0.2.3 默认不再是 function-body，顶层 `return` 被 TypeScript 擦除拒绝；按 `runtime.programFormat` 分支（function-body 用 `return`，其余用最终表达式完成值），smoke/冒烟不要写死。
- **Windows ACL 的交叉校验参数是 policy root**：`widenWindowsProfile` 的第四个参数必须传上游 profile 的实际 workspace（有效 policy root）；Session 身份与附加根授权仍来自原始主根。传原始主根会在 Session 移动后抛 `Windows ACL profile workspace does not match the policy root`。

## 外部复核补齐的接缝（2026-11-22）

外部 Code Review 复核确认并补齐了六个同源缺口，全部围绕「有效目录不是身份」与「两代夹具」：

| 缺口 | 修复 | 回归 |
|---|---|---|
| 不可用 authority 的进程 clamp 用有效目录 | `src/sandbox.ts` 的 `clampedExecution()` 用 `policyOriginRoot()`（无 live Session 时与 fs 一样回退 policy root）；Windows 交叉校验仍用 policy root | `tests/authority-boundaries.spec.ts`「clamps a moved Session to its origin」 |
| Windows ACL widen 用原始主根做交叉校验 | `widenForScope` 的期望 workspace 改传 `canonicalPath(policy.workspaceRoot)`，graft 根仍来自 scope | `tests/sandbox-multi-root.spec.ts`（Windows skip guard）+ CI windows lane |
| cold Session Files 按有效 wire root 查 Registry | `workspace-files.ts` 的 origin 优先读 `sessionPersistence.stat(id).header.cwd`，按请求缓存 | `tests/workspace-routing.spec.ts`「keys a stored Session…」 |
| `list` 回退分支漏 withheld 检查 | 回退 upstream 前独立执行 `underWithheldRoot` | `tests/workspace-routing.spec.ts`「refuses a list fallback…」 |
| 恢复后重复重放新活动 | 每个 Session 只重放一次、且只重放恢复前缀 | `tests/instructions.spec.ts`「does not replay post-resume activity…」 |
| schemastery peer 缺 alpha.2 宿主版本 | peer 显式追加 `3.20.0-alpha.1`；`compat:check` 新增单例 peer 覆盖断言 | `scripts/check-dsh-compat.mjs` 的 `singleton peer ranges` 输出 |

另外修复了两类 CI 夹具问题：旧车道 `profileContext` 缺 `overlays`（P1），以及 alpha.2 车道的 PTC 冒烟仍用函数体 `return`（额外发现）。详见路线账本的同名小节。

## 证据边界

本文只记录上游源码与发布元数据对照。本机与 CI 的执行证据（含 `0.2.3-alpha.2` 车道的 Auto Review 联合冒烟、三 OS 矩阵与实机目检）只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。
