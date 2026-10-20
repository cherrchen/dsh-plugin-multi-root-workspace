# Auto Review fork

基线：DeepSeek Harness `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`，`packages/experimental/auto-review/src/index.ts`。原文件保存在 `upstream.ts`；MIT 许可保存在 `LICENSE`。

允许差异：兼容层身份及必需服务；调用只读宿主 context builder；环境数据及当前 constraint 数据；native 副本的 metadata/digest 校验与去重；发送前、模型等待后、后续 gate 后和 dispatch 前的失败关闭/陈旧校验。dispatch 复核使用 registry token，涵盖人工批准等待，并随 owner 生命周期取消和 drain。

风险 policy、human/direct-parent/checkpoint/fact 角色判定、native/PTC 身份、严格输出协议、ask/never、下游 gate 与卸载时 Session 迁移保持官方语义。新增当前项目文本没有授权身份。没有全局 LLM hook、提示词文本匹配或第二 reviewer。

同步：先核对发布包与 tag 源码；人工审阅上游 policy、身份与 lifecycle 差异；更新 `upstream.ts` 和基线哈希；重放最小 context 差异；更新 `fork.patch`；运行差分门禁、官方回归、联合工具/装配/packed 与原生内核验证。绿色测试不能自动扩大联合支持版本。正式 context contribution API 足够后迁移 collector，移除 fork，保留联合测试。

Native 协调只使用现有 scope/delivery 索引证明的附加根来源；纯附加根旧帧留作 fact，以新快照替代。混合 native 帧若含陈旧的附加文件，公开接口不足以无损拆出 global/primary 正文，故拒绝本次审查并要求刷新 baseline。未登记 cwd 的 native 项目约束保持官方身份。


逐文件维护范围：

| 文件 | 来源/职责 |
|---|---|
| `upstream.ts` | 原始官方入口，哈希固定，不能当实现文件编辑 |
| `fork.ts` / `fork.patch` | 可执行 fork / 人工审阅的唯一入口差异 |
| `context.ts` | 当前 native baseline、scope metadata、历史 fact 与新鲜 constraint 分区 |
| `../compat/auto-review-packages.ts` | 精确执行副本门禁 |
| `../../tests/auto-review/upstream.spec.ts` / `../../tests/auto-review/parent.ts` | 同一 commit 的官方回归和 parent fixture；只调整导入、context stub 及新增环境字段断言 |
| `entry.ts` / `../compat/auto-review-loader.ts` | 单开关的 context/owner 生命周期、运行时接管与恢复 |
| `../../tests/auto-review/` 与 joint smoke | 上下文、工具、接管、启停和单包安装验证 |

主包的 `review-context` 与 instructions facade 是本地接口，不是上游正式 API。不再有独立 companion manifest 或主包 peer；普通 allowlist 的提升不能代替 fork 的同步和联合验收。
