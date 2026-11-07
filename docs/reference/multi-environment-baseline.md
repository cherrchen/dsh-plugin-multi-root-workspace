# 多执行环境 G0：基线入口与公开接缝

本文记录 [G0 计划](../plans/active/2026-11-06-multi-environment-gates.md)已经实现的取证入口及后续接线所需的源码事实。架构合同仍归 [ADR-0030](../decisions/ADR-0030-environment-and-root-identity.md)～[ADR-0034](../decisions/ADR-0034-binary-transfer.md)；各平台执行结果与关卡状态只归[路线图总账](../plans/active/2026-09-12-multi-root-workspace.md#多执行环境-g0-基线2026-11-07)。本轮没有远端 provider、连接、Registry 域或生产工具/面板入口；`g0_wait` 只存在于隔离的测试组合中。

## 重复取证

先构建，再运行：

```sh
pnpm build
pnpm baseline:multi-environment --upstream <本地上游-checkout>
```

`--upstream` 可省略，此时上游 SHA 标记为 `unverified`。它只记录该 checkout 的 HEAD 与 dirty 状态，**不证明** npm 安装物由这个 SHA 构建，也不修改上游工作树。脚本沿用 `scripts/lib/dsh-runtime.mjs` 的宿主解析、隔离安装和 profile boot 方法，不读取 SSH 配置、获取凭据或实例化 SSH 类。`DSH_CLI` 只允许解析到本安装树的同一入口；不同安装树在版本探测、测试或安装之前以 `G0_RUNTIME_MISMATCH` 拒绝。另一个 pin 必须使用独立安装快照。

输出目录是忽略的 `.dsh-smoke/multi-environment-g0-<随机值>/`：

| 产物 | 含义与限制 |
| --- | --- |
| `report.json` | schemaVersion 2：源码 provenance、文件数和内容摘要、manifest/lock/patch 摘要、Host OS/CPU/内核/Node、宿主锚定包版本、SSH 包缺席、FS 方法存在性、逐子进程命令/退出码，以及四组原生/插件自动差分。源码逐项枚举实际 src/scripts/tests（含未跟踪文件，排除 node_modules）；只有 Git top-level 等于采集根时才记 HEAD/dirty，否则明确标为 content-snapshot、sha=null。空文件树拒绝采集。方法存在不等于远端能力可用。 |
| `tests.json` / `tests.log` | 定向测试的逐项结果，保留 skipped；覆盖 FS 差分、真实 apply_patch、工具接缝、运行时归属/源码身份负例、真实工具行覆盖、process 入口、sandbox pass-through、provider conflict、可选依赖与静态 SSH 导入检查。不是完整回归或真实 SSH 验收。 |
| `baseline-*.yml` / `plugin-*.yml` | 在全新本地 `$DSH_HOME` 中安装原生及插件组合，保存 web/headless × `applyPatch: false/true` 的八份实际 CLI dump、摘要与行数。它们与实际执行 JSON 分开，不能单凭配置字段判工具已注册。 |
| `*-overlay.yml` | 保存测试覆盖层及摘要、目标行 ID。除顶层 tool-fs 外，还修改真实 Agent preset 中的 tool-fs，保留其他字段及 `!!js` 条件；Web 的顶层行本身被禁用，不能只改这一行。 |
| `baseline-*.json` / `plugin-*.json` | 每个组合由独立子进程启动。记录真实 Agent 的完整工具 schema、模型 wire 工具名、规范化 prompt 摘要、read/write/edit/apply_patch 的实际结果、raw FS 结果、shell 命令/退出/文件摘要及最终哨兵。rc.1 的 patch 开态实际增删改移，关态实际调用被拒；旧版两态都记录缺 API、无工具、调用拒绝及文件不变。Web 使用原生 preset 的 Agent factory；headless 使用未禁用的原生 runner 创建的 Agent。 |
| `compat.log` | 沿用既有精确版本门禁，不使用 `DSH_MULTI_ROOT_COMPAT=warn`。 |

每个实际组合都以本地脚本模型端点驱动 `g0_wait`，由真实 `agent.cancel()` 触发取消，核实原生 Agent/Session 身份、工具信号、正文停止与 turn/end；没有用手动 AbortController 代替这条链。真实 shell 需要本机内核可执行；不可执行时该组合失败，不将跳过算通过。

收集失败保留已完成项及 `status: failed`，退出非零。成功前还对每个 profile/开关逐项比较原生与插件的 schema、wire 工具名、服务可用性、raw FS 结果和最终哨兵。成功的 `local-baseline-recorded` 只表示本地采集完成；远端、其他原生平台与未测试入口始终单列 `unverified`。完整验证仍须执行 `pnpm compat:check`、`pnpm verify:all`、`pnpm docs:check`。比较其他 pin 时使用独立安装树，禁止用 checkout 回退主工作树的未提交 manifest。

### G1 本地委托对照

`pnpm baseline:multi-environment --local-facade` 输出到 `.dsh-smoke/multi-environment-g1-<随机值>/`，gate 记为 `G1`。每个 profile × applyPatch 两态再分空根与一个本地附加根两格；插件侧以 M1 相同的 disable + insert 接缝把 `multi-root-fs` 换成测试候选行 `g1-local-fs`（`tests/support/local-fs-facade.ts`），基线侧为未改动的既有插件。差分在 G0 字段之外再比较 scope、confine argv/enforcement、规范化 prompt 摘要（时钟、时长和随机 Web 端口被替换）及附加根写入效果；候选组合另断言未知远端 URI/target 在本地 IO 前被拒且同名本地哨兵不变。定向测试额外包含 `tests/local-fs-facade.spec.ts`。候选行不是包导出，也不进入生产 profile。

## 工具 → 服务 → 效果对照

| 入口 | 真实服务方法 | 当前基线应观察的效果 | 取证入口 |
| --- | --- | --- | --- |
| 原生 read | `ctx.fs.resolve` → stat/readText/streamText（按工具窗口选择） | 读取内容；本地 fs 写围限不构成读隔离，原生根外读取仍可成功。 | `tests/fs-parity.spec.ts`、真实 web/headless journey |
| 原生 write / edit | `ctx.fs.resolve` → writeText/editText | 空附加根时与上游同模式结果一致；有本地根时遵循 root access × Session mode × dispatch cap。拒绝后的哨兵不变。 | FS parity、`tests/tool-access.spec.ts`、behavior/journey |
| 可选 apply_patch | writeText / patchText / deleteFile / moveFile | rc.1 的增删改移走同一 fence，move 两端都检查；旧后端无方法时对应测试显式跳过。 | `tests/apply-patch.e2e.ts`、FS parity 的 patch 表 |
| raw FS service | 直接调用同一 `ctx.fs` 方法 | 不依赖模型工具包装；scope 与 Registry 准入仍在 provider 内。 | FS parity、`tests/registry-operation.spec.ts` |
| 原生 bash/pwsh | shell → sandbox / subprocess | 原生 shell 保留本地执行目标；真实受限进程由本机内核拒绝根外写。 | behavior/journey、`tests/process-entrypoints.spec.ts` |
| Agent PTY / PTC、用户终端 | process fence 包装公开入口 | Agent 与用户终端归属不变，Full-access 的 deny 不能绕过；无新增远端透明路由。 | process-entrypoints、完整进程回归 |

## 出树工具注册缝

`tests/multi-environment-baseline.spec.ts` 使用公开 `ctx.tools.register()` 在专用测试插件中注册 **`g0_local_probe`**，执行通过 `tests/support/tool-executor.ts`：旧版调用单工具 execute；新版结构探测 `setExecutor` 后接公开 `dsh-tools/pipeline`。该测试不注册 `remote_bash` 或 `remote_copy`，也不启动远端任务。

| 必须保留的接缝 | 自动断言 |
| --- | --- |
| 实验开关与生命周期 | false 时不注册，调用报错且正文计数为零；true 时可调用；插件 dispose 后再次调用报错，不再进入正文。 |
| 真实 Session 与调度身份 | Session 来自真实 event-sourced SessionStore，正文及 `tools/execute` 收到 `exec.agent.session`、`exec.name`、`callId`；参数中伪造 name/mode/sessionId 不改变身份。Agent carrier 是测试对象，实际模型 turn 由既有 web/headless journey 覆盖。 |
| 权限拦截 | `tools/pre-execute` 的 deny 在 around-dispatch 与正文之前生效。此用例验证公共拒绝接缝，不冒充某个产品权限规则匹配器的完整集成。 |
| tool cap | 真实 execute pipeline 经过 scope 的全局 around-hook；被 cap 的测试工具写本地附加根失败，实际哨兵内容保持不变。不能从模型参数选取工具身份。 |
| 每次读取会话政策 | 两个 Session 复用服务；写入一方的 `sandbox/mode` 后，下一次调用读取其新模式，另一方仍使用原模式。没有改共享默认值。 |
| turn 取消 | 单元夹具验证调用方信号；八组真实 profile 另验证真实 Agent turn → agent.cancel → 工具 AbortSignal → 正文停止 → turn/end。该结论不包含远端后代退出确认或 SSH 断线清理。 |

当前执行链的 around-hook 继续复用 `src/compat/tool-context.ts`，以 `global: true` 注册；没有为实验建立第二个工具身份来源。将来远端直调仍须实现 ADR-0030 的显式 owner 成功应答，不能把本次本地测试当作该应答。

## SSH 兼容门禁落地清单

本节是已接受决议在检查器中的改动位置清单。截至 2026-11-07 表中五处均已落地（状态与证据见路线图总账 G4 节）；按需装载器尚无生产调用方，连接构造仍未实现：

| 位置 | 后续改动与必须增加的负例 |
| --- | --- |
| `src/compat/dsh-version.ts` | 新增字面量 `SUPPORTED_SSH_RELEASES` 与 `SSH_PEER_PACKAGES`；SSH 集合是本地 allowlist 的后缀。四个 SSH peers 独立诊断，不加入 `CORE_PACKAGES` 或其 mixed 判定。低于地板、缺包、错版仅使 SSH 缺席，本地 compat verdict 不变。 |
| `package.json` | 四个包是 optional peers，range 与全量 allowlist 相同，以兼容上游逐 peer 的安装期检查；不得把 SSH 地板写成更窄的 manifest range。开发 SSH pin 允许与核心 pin 不同，但须恰为一个 SSH 支持成员。 |
| `scripts/check-dsh-compat.mjs` | 现有 §1 的全量 peer range 检查保留；核心 dev pin 集合排除 SSH 分类，另验 SSH dev pin；分类、peer 与 optional meta 互查，SSH 不进入当前 §5 的核心安装版本集合。缺 SSH 不失败，不使用 warn 绕过本地门禁。 |
| `src/compat/` 中的按需装载 | 通过平台、普通 compat、品牌、部署绑定后，从宿主锚点解析公开包；加载失败不能回退裸 SSH，也不能打坏本地 profile。错版、私有副本、缺传递依赖、连接构造前拒绝都要有独立用例。 |
| `scripts/check-pack.mjs` | 本轮已对所有 packed `lib/*.js` 及相对 chunk 检查静态 SSH import/re-export；允许动态装载，不把注释和示例字符串误判为导入。真正的按需加载隔离仍需 packed 无 SSH peers 的启动证据。 |

四包为 `dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh`（均在 `@deepseek-ai/` scope）。npm 分发和 Helper 载体的既有调查归 [ADR-0032](../decisions/ADR-0032-upstream-ssh-backend.md#核对结果fact)，本轮不重写其历史结论。

## 受管 SFTP 原语盘点

当前没有提供受信部署清单或可丢弃 SFTP 端点，以下是**待测端点清单**，没有任何方向被判为 supported。不能从本机 OpenSSH 版本或某个扩展名称推导服务器保证。

| 原语 / 证据 | 端点要实际证明的行为 | 缺席时的结果 |
| --- | --- | --- |
| `SSH_FXF_EXCL` | 以最小权限排他创建本操作 staging，同名抢占不覆盖；0 字节与大于 frame 的普通文件可受限流入。 | 不创建 staging，不开放该方向。 |
| `hardlink@openssh.com` | 同 FS 原子 no-replace；目标名被抢占时拒绝，发布与验哈希对象相同。 | 不以先 stat 后 rename 替代。 |
| `posix-rename@openssh.com` | 记录扩展支持及覆盖语义；普通可覆盖 rename 不能充当 no-replace。 | 仅有此扩展仍判发布能力不足。 |
| 对象及父目录绑定 | 验证后替换临时名、同 inode 改写、父目录移出根均不能转移发布对象或泄露内容；同时审计硬链接数。 | 路径型 SFTP 无法证明时拒绝，不能仅增加一次 realpath。 |
| staging 隔离与内容核验 | 其他工作进程不可改写，目标回读或受信摘要证实落盘内容；只上传账户另需受信核验端口。 | 不发内容或不开放发布能力。 |
| 主机与账户隔离 | 固定 host key、目标 OS、受保护配置、独立 OS 主体及 socket/凭据边界；本地 Agent 与远端构建进程不能复用传输身份。 | 建连前拒绝，不用 mkdtemp 0700 目录代替同 UID 隔离证据。 |

G2 按方向分别填写服务器实现/版本、扩展协商与实操结果、部署主体、竞态参与者和清理责任；凭据及完整配置不入库。合同及拒绝条件以 [ADR-0034](../decisions/ADR-0034-binary-transfer.md) 为准。
