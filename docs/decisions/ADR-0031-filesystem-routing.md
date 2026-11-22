# ADR-0031：单一文件系统入口与环境内分派

**状态** Accepted · 2026-11-06。已接受架构合同，实验默认关闭；各项能力须通过对应验收才可开放。

## 现有调用链（Fact）

| 入口 | 当前执行位置 |
| --- | --- |
| read / write / edit / 可选 apply_patch | tool-fs → `ctx.fs`；本插件继承 LocalFileSystem，写入经过 Registry 准入和 fs fence。新版后端的 patch、delete、move 经结构探测安装，move 在同一次准入校验两端。[FS](../../src/fs.ts) / [兼容适配](../../src/compat/fs-patch.ts) |
| bash / pwsh、Agent PTY、PTC | shell、terminal、ptcRuntime 消费 sandbox / subprocess；Full-access 有跳过 confine 的路径，[process fence](../../src/process-fence.ts) 包装服务入口。面板用户终端另有归属。[ADR-0011](./ADR-0011-multi-root-workspace-consumers.md) |
| Files / watch、LSP | Web Files 调用 workspaceFiles；LSP 还需同环境 file URL 和服务进程。[Files](../../src/workspace-files.ts) / [LSP](../../src/lsp.ts) |
| AGENTS / CLAUDE、Skills | 按本地根发现、读取并维护会话投影，需独立审查远端 IO 和撤回。[Instructions](../../src/instructions.ts) / [Skills](../../src/skills.ts) |

[组合 patch](../../cordis.patch.yml) 只替换 fs-sandbox 和 sandbox 两个上游 provider 行。本地 FS 和 sandbox 免 compat 硬注入以保住 profile；[品牌门禁](../../src/providers.ts)决定其他扩权行能否启动。rc.1 的 tool-fs 由配置决定是否注册 apply_patch；base 的 `applyPatch: false`，实际应按 profile 核对。[上游 base patch](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/bundle/base/cordis.patch.yml)

## 路由合同

先保留当前 `MultiRootFileSystem` 的本地实现，用仅有 local backend 的测试组合验证委托能保留上游行为。远端显式工具可先调用各自 backend；切换生产 `ctx.fs` 的条件是所有公开方法及全部已启用消费者通过差分测试。届时由一个带原品牌的门面持有本地和远端 backend，保持同一个服务键。新增远端行须注入 compat、品牌及 Registry。门面与主 barrel 禁止静态加载可选 SSH peers。[ADR-0001](./ADR-0001-provider-replacement-scope.md) / [ADR-0002](./ADR-0002-upstream-coupling-policy.md) / [ADR-0009](./ADR-0009-dsh-compat-contract.md) / [ADR-0014](./ADR-0014-root-limit-and-provider-conflict.md)

```text
显式远端端点 → 已验证 session → Registry 双端或单端准入 → 环境能力检查
             → 在目标端定位登记根并执行受限 IO → 带环境的结果
原生本地路径 → 既有 MultiRootFileSystem → 既有本地 fence / IO
```

| 接口 | 远端门面的必要行为 |
| --- | --- |
| resolve / lstat | 显式选择环境和根后在目标端解析。相对路径只相对该根，拒绝绝对路径注入、NUL、逃逸及编码歧义。不得先用 Host 的 path.resolve 折叠 symlink/..。普通路径交回本地，失效的远端引用直接报错。 |
| FsTarget / contains / fileUrl / processPath | 对外 key 区分环境、绑定代次和 backend key。displayPath 可用 `remote://环境ID/根ID/相对路径`；只在 backend 内解包原始 target。contains 跨环境为 false。通用本地 consumer 不得收到可误作本地的远端绝对路径或 file URL；仅已绑定同一执行环境的 consumer 可取原生值。公开同步方法不能表达此边界时，该 consumer 不开放。 |
| stat / listDir / readText / streamText / readBytes / readByteRange | 包括目录子项、stream 生命周期、读范围和错误，均不得泄露根外路径或字节。路径解析与实际打开之间的替换须由目标端防住。每次打开重新准入，流有界、可取消。 |
| write / edit / patch / delete / move | 保留调用者身份、expected version、create-if-absent、原子修改、错误码及观察事件。返回和接收的版本守卫绑定目标及环境代次。move 的 source/destination 同次校验；跨环境拒绝，调用者显式选择 [Transfer](./ADR-0034-binary-transfer.md)。批量 patch 逐项报告已产生的效果，不能许诺整批原子。 |

**本地回落与陈旧引用。** 分派先识别远端引用，再查此 Session 的准入和能力。禁用、根撤销、错误传入的 target 和未知代次均在本地 IO 之前报错。可解析的 URI 和缓存的 FsTarget 只用于定位；直接调用服务、重载后恢复的版本令牌、listDir 返回的子 target 均重走同样边界。流在打开时准入，并受操作时限、读取预算和取消约束；关闭后继续迭代或改用新连接需要新准入。

按实际 DSH pin 探测公开方法。老版本保持方法缺席，新方法未经审计不得对远端分派。Files、下载、watch、LSP、instructions、skills、PTY/PTC 均按独立能力投影；首期不给远端根注册这些消费者。若以后支持远端指令，沿用 user context、字节预算与撤回。入口先声明[平台和权限合同](./ADR-0030-environment-and-root-identity.md)；后端门槛通过后，面板才展示可用根和操作。SSH 根只展示当前有效模式，本地根继续提供原有权限编辑。

## 备选、验收与回滚

- **首个 POC** 保留 LocalFileSystem 子类的本地快速路径，最小委托易回退；继承所得的未覆盖方法可能落到本机，因此不能直接给这个实例传远端 target。
- **长期候选** 组合式 `extends FileSystem` 门面能显式枚举方法，代价是复现各 pin 的同步返回、观察事件和错误契约。只有当独立 backend 和 local-only parity 实测优于继续显式工具时才切换。
- 拒绝在同一个 Context 再挂 SshFileSystem 竞争服务，也拒绝按当前连接或裸路径选择 backend。本地方言继续按 [ADR-0003](./ADR-0003-dialect-grant-widening.md) 生成，不接收远端根。

**切换门槛。** 哪些原生 consumer 会在调用 resolve 前把 URI 转成本机绝对路径，或把 processPath 转给本机进程？逐 pin 走真实 tool-fs 和 Files 入口；两个环境同名文件交叉喂入 target/version，测试 apply_patch 增删改移两端、目录竞态和旧 pin。不能证明归属的入口仅支持本地。回滚移除实验 backend/可选行，恢复原实现；空根与纯本地用例须保持相同工具清单、提示内容、sandbox argv 和拒绝结果。
