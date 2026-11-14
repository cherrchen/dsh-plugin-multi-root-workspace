# Auto Review fork

本目录保存可选 Auto Review 集成的两代上游 reviewer fork。每代对应一个冻结的上游源码代际，各自有逐字节基线、显式差异和编译 pin；MIT 许可保存在 [LICENSE](./LICENSE)。

| 基线 | 发布 | 上游 | 基线提交 | `index.ts` blob |
| --- | --- | --- | --- | --- |
| `0.2.1`（legacy） | `0.2.1-rc.2` – `0.2.1-rc.5` | `dsh-v0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` | `d4975b54f5` |
| `0.2.2`（current） | `0.2.2-alpha.2` – `0.2.2-rc.3` | `dsh-v0.2.2-alpha.3` | `05b1cae8db6e674c5685101494d4eec24652424a` | `29df7771f0` |

两代 reviewer 的输入模型不同（`0.2.2-alpha.2` 起为固定 system + 每条保留项一条 user message、逐项 tool-schema、跨审查 schema 复用），因此不能共用一份实现。开发 pin 属于哪个基线，就只类型检查对应实现；运行中的宿主只加载自己的那份 bundle（入口按已安装发布动态加载，见 `entry.ts`）。`0.2.2-alpha.2` 的 `GenerateOptions.purpose` 仍是闭集，因此该发布不发送 `sessionId`/`purpose`，由 `autoReviewRequestIdentity` 决定。

允许差异（两代共同）：兼容层身份及必需服务；调用只读宿主 context builder；环境数据及当前 constraint 数据；native 副本的 metadata/digest 校验与去重；发送前、模型等待后、后续 gate 后和 dispatch 前的失败关闭/陈旧校验。dispatch 复核使用 registry token，涵盖人工批准等待，并随 owner 生命周期取消和 drain。

基线 `0.2.2` 额外的允许差异：把当前附加根约束作为 constraint 项插在环境消息之后、保留项之前（镜像 0.2.1 代的 `PROJECT_INSTRUCTIONS` 位置，保持上游“环境固定、历史只追加、待审调用最后”的前缀缓存前提）；`FiberState.ACTIVE` 改写为带注释的字面量 `2`，因为 cordis 发布包的 `FiberState` 是 const enum，没有运行时导出。

风险 policy、human/user、direct-parent、checkpoint、fact 角色判定、native/PTC 身份、严格输出协议、ask/never、下游 gate 与卸载语义保持官方语义。新增当前项目文本没有授权身份。没有全局 LLM hook、提示词文本匹配或第二 reviewer。

同步：先核对发布包与 tag 源码；人工审阅上游 policy、身份与 lifecycle 差异；更新对应基线的 `upstream.ts` 与 `locales.ts` 哈希；重放最小 context 差异；更新该基线的 `fork.patch`；运行差分门禁、该基线官方回归、联合工具/装配/packed 与原生内核验证。绿色测试不能自动扩大联合支持版本；新增发布属于人工契约变更（`src/compat/auto-review-contract.ts`）。正式 context contribution API 足够后迁移 collector，移除 fork，保留联合测试。

Native 协调只使用现有 scope/delivery 索引证明的附加根来源；纯附加根旧帧留作 fact，以新快照替代。混合 native 帧若含陈旧的附加文件，公开接口不足以无损拆出 global/primary 正文，故拒绝本次审查并要求刷新 baseline。未登记 cwd 的 native 项目约束保持官方身份。

逐文件维护范围：

| 文件 | 来源/职责 |
|---|---|
| `legacy/upstream.ts`、`current/upstream.ts` | 各代原始官方入口，哈希固定，不能当实现文件编辑 |
| `legacy/fork.ts`、`current/fork.ts` + 对应 `fork.patch` | 各代可执行 fork / 人工审阅的唯一入口差异 |
| `current/locales.ts` | `0.2.2` 代的上游 locale 字典副本（哈希固定） |
| `partition.ts` | 基线无关的 native baseline、scope metadata、历史 fact 与新鲜 constraint 分区 |
| `../compat/auto-review-contract.ts` | 联合支持合同、基线映射、编译 pin 与请求身份 |
| `../compat/auto-review-packages.ts` | 精确执行副本门禁 |
| `entry.ts` / `../compat/auto-review-loader.ts` | 单开关的 context/owner 生命周期、运行时接管、按基线动态加载与恢复 |
| `tests/auto-review/legacy/`、`tests/auto-review/current/` | 各代官方回归与上下文/围栏测试；`parent.ts`、`loader.spec.ts`、`ops-context.spec.ts` 为共享回归 |
| `../../scripts/lib/auto-review-battery.mjs` 与 joint smoke | 跨两代的真实 reviewer 请求、写围栏、接管、启停和单包安装验证 |

主包的 `review-context` 与 instructions facade 是本地接口，不是上游正式 API。不再有独立 companion manifest 或主包 peer；普通 allowlist 的提升不能代替 fork 的同步和联合验收。
