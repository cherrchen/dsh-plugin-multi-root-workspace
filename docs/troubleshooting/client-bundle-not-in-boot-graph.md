# client bundle 不进 web 启动图：bundle patch 只挂子路径行

## 症状

- 侧边栏 footer 的"工作区文件夹"入口（`sidebar.footer.action` 槽位注册）完全不显示，但宿主半部工作正常：`/workspace-folders` 命令出现在命令面板、RPC 通道有响应。
- 运行中的 web 服务返回的 `window.__DSH_BOOT__` 模块图里没有 `@dsh-electron/dsh-plugin-multi-root-workspace` 条目；直接请求 `/plugins/??@dsh-electron/dsh-plugin-multi-root-workspace/client.js` 返回 404。
- 全程无显眼报错：增量扫描失败只进 `logger.warn`，页面控制台也没有与插件相关的错误。

## 根本原因

宿主把 client bundle 收进启动图的唯一途径是扫描 loader 行（`ClientModuleRegistry`，上游 `packages/client/modules/src/index.ts`）：它取每个 loader 行的 `name`（模块 specifier）去解析包清单，再读取 `dsh.client` 声明。解析入口 `locatePkgJson` 对**子路径 specifier 直接短路返回 undefined**——上游源码注释原话是 "subpath entries (…/gateway) land here — permanently not a client row"。只有挂在**裸包名**上的行才会被读取 `dsh.client`。

本插件的 `cordis.patch.yml` 此前只插入五个子路径行（`…/fs`、`…/sandbox`、`…/scope`、`…/registry`、`…/command`），没有一行挂裸包名，所以 `dsh.client` 声明永远不被扫描，浏览器端 `apply` 从未执行，槽位注册自然不发生。

对照：`dsh-plugin-git` 的 patch 只有一行 `name: '@dsh-electron/dsh-plugin-git'`（裸包名），所以它的 client 半部（词典、UI）能正常加载。

为什么 M3 验证没有发现：`smoke:journey` 的 web 腿在进程内启动浏览器组成，只断言了宿主侧事实（命令注册、scope 授权、Connection 存在）；client 侧当时只有制品字节断言与 jsdom 渲染单测，恰好都绕过了真实的模块图组成。

## 诊断方法

1. 抓启动注入：`curl 'http://127.0.0.1:<port>/?token=<token>'`（token URL 会 303 设置 cookie，需回放 cookie 再请求 `/`），在返回的 HTML 里找 `__DSH_BOOT__` 的 `entries` 列表，确认有无本插件的 id。
2. 直接探测 bundle 路由：`/plugins/??@dsh-electron/dsh-plugin-multi-root-workspace/client.js`，404 即未收录。
3. 对照 loader 行：`dsh --profile <profile> --dump-config`，检查插件插入的行中是否有 `name` 恰为裸包名的行。

## 已验证的解决方案

1. 给包根 `src/index.ts` 增加最小载体插件面（`inject: []` + 空实现 `apply`，有意不提供任何服务）；
2. `cordis.patch.yml` 追加一行 `id: multi-root-client`、`name: '@dsh-electron/dsh-plugin-multi-root-workspace'`，作为 client 扫描锚点；
3. `pnpm build` 后重启 web 运行时，确认 `__DSH_BOOT__` 出现插件条目、`/plugins/??…client.js` 返回 200、footer 入口恢复显示。

回归防护：`tests/patch.spec.ts` 钉住锚点行的存在与裸包名形态；`scripts/smoke-compose.mjs` 在真实安装链上断言六行插入；`scripts/smoke-journey.mjs` web 腿断言组成的 boot graph 确实包含插件 client 条目。
