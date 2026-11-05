# dsh-ops × Multi-Root Workspace 兼容性审计

> 证据交付说明（2026-11-05）：按用户要求，本目录只提交本 Markdown。文中的 `dsh-ops-audit-evidence/` 及“本地”文件名保留为历史核验索引，原始日志、JSON、临时脚本均未提交，也不保证在干净检出中可用。P5 可复跑程序见[本仓验证脚本](../../scripts/verify-ops-protection.mjs)；当前能力以 ADR 的 P5 修订及总账为准。

首次审计：2026-10-31；架构复核更新：2026-11-01（Asia/Taipei）。范围：源码、隔离测试、报告；未修复实现、修改真实 profile、提交 commit/PR 或放宽外层沙箱。

## 1. 结论与证据等级

**当前组合不能认定为权限安全兼容。已确认 OPS Native `ops_write_file` 能修改 Full-access Session 中被 Multi-Root 显式登记为只读的附属根。** 同一 fixture 上原生 Multi-Root 文件写入被拒，文件哈希保持不变。复现启用了真实共享 Registry、真实 provider 品牌门禁、真实工具分发与 Multi-Root process fence，并非只比较两个独立的权限计算函数。

**OPS 没有在已覆盖路径中主动删除 Multi-Root 上下文。** 两种加载顺序的真实 AgentLoop 请求均保留根级指令；嵌套指令的问题是**未触发注入**：Multi-Root 同时在参数解析和 `fs/observed` 补充路径限制工具名为 `read/write/edit`。OPS 成功读取和观察文件，仍不使目录进入嵌套指令发现集合。恢复官方 `read` 后，下一次模型请求出现嵌套指令。

**OPS Bash 的 Full-access 路径存在明确源码风险，但本轮未动态确认 Windows 内核越权。** 当前内置预设实际只在 Windows 发布它；macOS 的入口探针只记录 argv，没有启动进程。受限 macOS 子进程执行另受外层环境 `sandbox_apply: Operation not permitted` 阻断。

状态定义：

- `CONFIRMED`：在明确记录的动态环境复现。
- `CODE_RISK`：源码推导，包含 `INFERRED` 结论；没有相应端到端动态确认。
- `PASS`：指定用例实际通过，结论限于该用例。
- `NOT_TESTED`：没有完成对应动态验证，包括执行受环境阻断；绝不等同于通过。
- `NOT_APPLICABLE`：当前公开接口或实际发布/注册契约不支持该方案/组合。

### 问题与通过项总表

| ID | 优先级 | 子系统 | 预期契约 | 实际行为 | 证据 | 状态 | 影响版本/平台 | 建议修复归属 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | P0 | OPS Native 写入 | 显式只读附属根在 Full-access 仍不可写 | `ops_write_file` 成功替换标记文件；原生 fs 拒绝 | §4、E1、O1/M1/M2 | **CONFIRMED** | 当前 OPS / MR v0.1.13 / DSH 0.2.0-rc.2 / macOS arm64；OPS 0.4.4 为 CODE_RISK | OPS 上游主修；双方授权契约 |
| F02 | P0 | toolAccess / Registry 降级 | 每个新操作消费有效scope；fs降级与进程证明拒绝分开（§14 A10） | OPS 固定文件桥不消费 cap、deny、Registry epoch；spawn 的 admission 存在不等于生成 deny profile | O1、M2；§5 | **CODE_RISK · INFERRED** | 两版 OPS 相同核心路径；其他平台未实测 | 双方协作；OPS 执行桥接入 |
| F03 | P0 | OPS Bash / batch | Full-access 局部拒写必须落到执行进程 | OPS 跳过 confine，直接 spawn；没有经过 MR 的 shell/PTC prepare 入口 | O2、O3、M2、E4 | **CODE_RISK · INFERRED** | Bash：Windows内置预设；shared FA有deny的PTC链现判安全拒绝，端到端未测（§14 A4） | OPS 上游 + 双方进程授权接缝 |
| F04 | P1 | 可写附属根可用性 | 固定 RW 在会话 RO 下仍可写；WW 可写附属根可写 | OPS 会话 RO 全拒固定文件写；WW 只承认主根/私有 temp | O1、M1、ADR-0017；§5/§11 | **CONFIRMED（dry-run预检误拒；实写未测）** | 当前OPS/macOS预检确认；0.4.4仍为CODE_RISK | OPS 上游接入统一授权 |
| F05 | P1 | 嵌套 AGENTS.md | 成功 OPS 文件活动使其父目录链可发现 | OPS inspect/read_files 成功、发出观察，但嵌套指令不注入；官方 read 后注入 | M3、O1、E2/E3 | **CONFIRMED** | 当前 OPS / MR / macOS；0.4.4 为相同源码路径推论 | **Multi-Root 自行适配**；双方提供活动契约 |
| F06 | P1 | Auto Review 来源重建 | 审查包含当前目标及成功活动的嵌套指令 | target/replay只认read/write/edit + file_path，漏OPS目标仍标complete，违反ADR-0021（§14 A7） | M3、M4、§7 | **CODE_RISK · INFERRED** | MR v0.1.13；Auto Review 精确基线为 DSH 0.2.1-rc.2，本轮宿主不在该边界 | Multi-Root 主修 |
| F07（N1） | P1 | Linux bwrap cache/profile归属 | 合法cache可见性不能破坏本次证明或覆盖deny | confine后追加cache bind会改变记忆prefix；结构探针确认不匹配 | §13、cache-profile探针与源码 | **CODE_RISK（Linux组合）；函数级冲突已复现** | shared+bwrap的WW：全部到达该分支且有有效cache的batch/result；常规RO/Landlock不在此结论 | OPS在confine前声明cache需求；MR保留严格证明 |
| P01 | P1 | 拓扑、指令、去重 | 保留已有用户指令；只缩减有证明的重复工具正文 | 实际 provider 请求保留根指令、Skill；去重回归验证 compaction/projection 后恢复完整正文 | E2/E5；O5/M1 | **PASS（限已测路径）** | 当前组合；0.4.4 去重独立测试 | 已覆盖路径无需改动 |
| P02 | P1 | Skills | 枚举/加载/显式调用/撤销独立于 OPS schema | RO 默认无候选；显式开启后发现并加载；显式调用进入模型请求；撤销后 catalog 清空并通知 | E2；M5 | **PASS** | 当前组合、两个加载顺序 | 无需改动 |
| P03 | P2 | 注册与生命周期 | 作用域内遮蔽、下一请求发布、卸载恢复 | 延迟发布 ops_stat；默认隐藏 read，兼容配置/卸载恢复；无 provider 冲突 | E2/E5；O4 | **PASS（限已测路径）** | 当前组合 macOS；Windows/Linux 是源码推断 | 已覆盖路径无需改动 |
| P04 | P0 | 根重叠注册 | 不接受主根重叠/相互嵌套附属根 | 注册分别拒绝 primary-overlap / nested | E2；M6 | **PASS** | 当前 MR、两个加载顺序 | 无需改动；重叠授权矩阵 NOT_APPLICABLE |

## 2. 基线：先核对代码和宿主

| 项目 | 实际取证值 |
| --- | --- |
| Multi-Root | `@dsh-electron/dsh-plugin-multi-root-workspace@0.1.13`；HEAD/tag `v0.1.13` = `4e45e25aa34aa39c926b6f3908a22f8b265b1f1c`；开始时工作树干净 |
| OPS 当前待兼容版本 | manifest `0.5.0-alpha3`；HEAD `2c0b0397ce4b48436ff76cf5c5b039054240a45c`；describe `v0.5.0-alpha3-1-g2c0b039`；开始时工作树干净 |
| OPS 已发布对照 | 本地 `v0.4.4` tag = `fc11890f7668c9912fcde1df1ca89810e1cbc031`；单独 archive、构建 TS/Rust；未冒充当前安装版本或验证 npm tarball 与 tag 字节相同 |
| 原 MR 开发安装树 | DSH `0.2.2-alpha.2`、Cordis `4.0.6-alpha.1`；该 DSH 在 OPS peer `<0.2.2-0` 之外，不用于组合通过结论 |
| 原 OPS 安装树 | 本地仓库没有 node_modules、lib、runtime；其 dev pin 为 DSH `0.2.0-rc.2` / Cordis `4.0.4` |
| 本轮统一测试宿主 | 发布 npm 包 DSH 服务 `0.2.0-rc.2` / Cordis `4.0.4`；实际可解析的顶层 `@deepseek-ai/dsh-*` 全部为这一版本；MR compat 使用 enforce，未使用 warn |
| 系统 | Darwin 24.6.0、arm64；Node `v24.18.0`、pnpm `11.25.0`、cargo/rustc `1.98.0` |
| Agent/preset | P0 使用受支持的显式 consumer `preset: audit`，Native，residentNames 明确包含 write_file；AgentLoop 使用 Standard，另做 Cordis/Minimal/PTC 发布探测 |
| sandbox / OPS 配置 | P0：danger-full-access + 显式 read-only 根 + sharedStorageRoot；未配置 toolAccess。上下文：workspace-write，后切 read-only；OPS 单行默认配置，后开 standard.hideOfficialTools=false |
| 用户实际宿主 | PATH 没有 `dsh`；本轮没有读取用户 profile 或断言正在运行的桌面产品版本。这里报告的是统一隔离宿主，不是用户生产安装认证 |

版本事实来自 manifest、git 对象和实际模块解析，未访问远端 main 代替本地版本。隔离目录见证据脚本；所有测试数据、DSH_HOME、Registry store 和 npm/Cargo 缓存均在系统临时目录。首次 npm ci 因默认用户缓存不可写而失败，改用临时缓存后成功；没有改用户缓存所有权。

### 两版 OPS 的实质差异

当前版的 `src/file/worker.ts` 只是重导出，真实路径迁至 `src/execution/files.ts`。旧版的静态检查和只读/WW 写边界、Full-access 无 confine Bash 分支仍与当前版一致；因此未发现能消除 F01–F04 的版本变化，**不据此把旧版升级成 CONFIRMED**。

当前文件 cwd 通过 `workingDirectory.ensure(agent)`（服务存在时）解析；旧版固定文件桥使用 Session header cwd。0.5 将单行 consumer/publication 分层，删除旧 `dsh-ops/compat` 导出；0.4.4 仍有该兼容行。当前保留官方工具应使用 `standard.hideOfficialTools: false` 等内置配置或 public integration 的 `replaceOfficial: false`，不能照搬旧行。两版 schema/生命周期不能一概视为相同。

当前 README 有 macOS/Linux 使用 Bash 的表述，但内置 assembler 仍以 `process.platform === 'win32'` 门控 shell（O4）。所以本报告以代码和实际工具列表为准，不把本机不存在的 ops_bash 算作“安全通过”。

## 3. 四条执行链与接缝

### 3.1 原生 DSH 文件与 Shell

```text
read/write/edit（真实 dsh-tool-fs）
  → tools.execute → tools/execute（MR cap / admission / activity ALS）
  → fs.resolve（Session cwd）
  → read: stat/readText + fs/observed
  → write/edit: MultiRootFileSystem.writeText/editText
      → Registry.withOperation → effective scope
      → checkedTarget: authority fallback / canonical boundary / deny优先 / writableRoots
      → LocalFileSystem 原子发布

bash/pwsh → ctx.shell.execute(spec.sandboxPolicy)
  → MR wrapper: Full-access 时 prepare(scope) → PreparedDeny ALS
  → 原生 executor → subprocess.spawn
  → MR spawn: 有 PreparedDeny 才加受限 prefix
受限模式原生 executor → ctx.sandbox.confine → MR profile grant/deny → spawn
```

原生工具代码来自实际安装的 `@deepseek-ai/dsh-tool-fs@0.2.0-rc.2/lib/index.js`；精确编号摘录和 SHA256 在 E6。MR 栅栏见 M1/M2。`ctx.subprocess.spawn` 的 spec 没有可信 Session policy 字段，不能仅看到它被包装就假定每个调用都被沙箱化。

### 3.2 OPS Native 固定文件操作

```text
实际发布的 ops_inspect_local_file / ops_read_files / ops_replace /
ops_write_file / ops_edit_file / ops_copy / ops_move / ops_remove
  → scoped publication → NativeFileTools.definition/call
  → execution/files.invoke → resolveSessionDirectory
  → sandboxPolicy.resolve({session})
  → 路径绝对化 + host-owned anchors + credential fence
  → RO 全拒 mutation；WW 限 workspaceRoot + 当前Session私有temp；Full-access 不限这组写根
  → JSON: read_only、credential deny_roots、仅 WW 时 write_roots
  → 可选 ctx.fs.resolve/stat（观察，不授权写入）
  → policy mode/workspaceRoot 二次比较
  → execution/transport.exchange → ctx.subprocess.spawn([RustWorker])
  → Rust no-follow / CAS / request.authorize_path / write_roots → 实际读写
  → observations + 工具输出/Outcome
```

工具是能力目录中的真实实现，**不表示默认全部常驻**。写工具默认通过 discovery 选择或明确配置才发布；P0 用 public integration 将 write_file 常驻，未手工替换工具执行函数。

关键差异：该桥不调用 `ctx.fs.writeText/editText`，也不调用 `ctx.sandbox.confine`。传给 Rust 的 deny_roots 来自 OPS credential policy，**不是 Multi-Root deniedRoots**。第二次 policy 检查只比较 mode/workspaceRoot，不比较 Registry epoch、附属根撤销或 cap。Rust 在自己的输入授权下做 no-follow 和 CAS，是有价值的文件安全措施，但不能凭空知道未传入的只读根。

copy 只要求目标可写，源侧做读取/credential/path 检查；move 要求源与目标都可写；remove 要求被删路径可写。其语义差别正确，仍共同依赖 OPS 自有授权输入。源码：O1、O6。

### 3.3 OPS Bash

```text
内置预设/显式consumer publication → session-shells → startSessionBash
  → standing policy 与当前 mode/workspaceRoot 一致性检查
  → prepareWorkspace
  → mode != Full-access: ctx.sandbox.confine → 校验 full/partial → confined argv
  → Full-access: 原始 argv
  → OPS shells/execution → ctx.subprocess.spawn
```

不调用 `ctx.shell.execute`，没有设置 MR 私有 `processDenyStore` 的入口。MR 的 aroundTool 共享 admission 只提供本次 scope，不会自动调用 `prepare()`；spawn 在 store 缺席且 argv 不带已识别 confined profile 时可以直通（M2:116–119、167–176）。这就是 F03 的具体缺口，不能解释成“所有 subprocess 已兜底”。

`command` 和 `script_path` 在同一 prepare/spawn 路径汇合。OPS 不接受 per-call sandbox_permissions/justification 升级参数；它提示变更 Session mode。受限分支允许 enforcement full 或 partial，不能统一称为完整内核约束。未把无 Agent 标记的用户终端直通设计列为漏洞。

### 3.4 OPS PTC SDK 与 batch

```text
run_code → 宿主 PTC runtime → SDK host dispatch / tools.execute
  → OPS publication/ptc 的 scope、presentation、lifetime校验
  → execution/monitored
      FILE_TOOLS → execution/files（与 Native 共用固定文件桥）
      batch/result → execution/jobs → 受限时 confine；Full-access跳过 → Rust
  → typed Outcome（与 Native 文本独立）
```

宿主原生run_code的ctx.ptcRuntime.run在MR wrapper覆盖之内。§14 A4补证后，shared FA有deny且store沿pipe继承的源码链应判为**安全拒绝**：内层dispatch新开frame，外层PreparedDeny不属于内层。函数级归属冲突与通用pipe继承已复现；完整PTC+OPS仍NOT_TESTED，其他模式/legacy不泛化。不能把“同一文件桥有授权缺口”直接当成该PTC链已越权。

源码：`publication/ptc.ts:107–125`、`execution/monitored.ts:18–24`、O3；宿主 PTC 入口实际包摘录见 E6。

### 3.5 Provider、Hook 与工具作用域

两个插件没有直接依赖。MR 提供 fs/sandbox、检查自己的品牌并包装公开 shell/PTC/subprocess 入口；OPS 不注册竞争性的 fs/sandbox provider，不覆盖这些服务的方法，而是消费它们并在自己的作用域注册工具。

OPS **确实调用 tools.restrict()**：`publication/replacements.ts:95–100`、`discovery/controller.ts:231`、`publication/ptc.ts:228`，另有 legacy 遮蔽路径。它是 per-agent restriction mask，不是 Service provider 抢占，也不是重写全局 register。MR 的 provider 品牌检查不会阻止不经过 fs/sandbox 写接缝的 Rust 操作。

## 4. F01：唯一一次潜在越权写入的最小复现

E1 = p0-results.json（本地 `p0-results.json`），可重跑脚本见 p0-repro.mjs（本地 `p0-repro.mjs`）。脚本会创建全新、无敏感内容的 fixture；不要改为真实目录。首次确认后未扩大潜在越权写入范围，也没有为了覆盖旧版再次实施相同越权。

1. 在统一宿主挂载真实 policy、工具、MR fs/sandbox/providers/compat、共享 Registry、process fence。
2. 创建 primary 与 additional，Registry.add 将 additional 登记为 read-only。返回 available、shared=true、skillsEnabled=false。
3. 在 Full-access Session 中，public OPS integration 发布 write_file。
4. 原生 `ctx.fs.writeText` 写同一标记文件，得到 `FS_SANDBOX_DENIED`。
5. tools.execute 调 `ops_write_file`，参数 path 为该文件，expectedRevision 为测试前 SHA256，content 为 `OPS_AUDIT_MARKER\n`。
6. 返回 isError=false、status=completed、changed=1；重新从磁盘读取并计算 SHA256。

| 观察 | 实际值 |
| --- | --- |
| 写前内容 | `before audit\n`（13 bytes） |
| 写前 SHA256 | `1a1f8b1164e70157a1b21498a51e21360f36dd88eede45cf974db70f725dffeb` |
| 原生被拒后 SHA256 | 与写前相同 |
| OPS 结果 | completed；changed=1；sandbox.enforcement=policy；boundary=trusted-native-file-operations |
| 写后内容 | `OPS_AUDIT_MARKER\n`（17 bytes） |
| 写后 SHA256 | `949af5ac6cd128f401fa10c66e7f049e339dce540b461561bba66d5a36226561` |
| 文件状态 | 原路径仍存在，内容被替换；不是只凭工具文案判成功 |
| Worker argv | 裸 Rust Worker 可执行文件；无 sandbox runner prefix |

**成因**：Full-access 不向 Worker 传 write_roots，credential deny_roots 不包含这个附属根；该调用没有进入 MR shell/PTC prepare。即使 owner admission 已建立，spawn 也没有 PreparedDeny，仍执行裸 Worker。CAS 只证明覆盖的是预期版本文件，不证明有写权限。

**影响界限**：动态确认仅为当前 OPS、此 Native 工具、macOS、Full-access + 显式只读根。其他写工具、toolAccess、Registry unavailable、Windows/Linux 和旧版的相同问题只能按源码标注，不能由这一个结果冒充全矩阵确认。

## 5. 权限矩阵：契约与实际覆盖分开

下表“应有”来自当前 `scope.project/effectivelyWritable`、fs fence 和 [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)。主根/普通外部路径分别按 Session mode；附属根再取 toolAccess 交集，deny 优先。普通外部路径指**非宿主临时 grant**的未注册路径；受限模式对平台 temp 的既有 grant 不能误当越权。

`允/拒` 是源码契约，**没有测试状态时不表示已实测**。OPS 一栏仅讨论独立、在主根和 OPS 私有 temp 之外的附属根。

| Session | 附属根策略 | 主根应有 | 附属根应有 | 普通外部应有 | OPS Native 附属根静态结果 | 动态状态 |
| --- | --- | --- | --- | --- | --- | --- |
| read-only | read-only | 拒 | 拒 | 拒 | 拒 | NOT_TESTED |
| read-only | inherit | 拒 | 拒 | 拒 | 拒 | NOT_TESTED |
| read-only | read-write | 拒 | 允 | 拒 | 拒：F04，过度限制 | 实写 NOT_TESTED；预检误拒 CONFIRMED（§11） |
| workspace-write | read-only | 允 | 拒 | 拒 | 拒（碰巧符合，原因不是MR策略） | NOT_TESTED |
| workspace-write | inherit | 允 | 允 | 拒 | 拒：F04 | 实写 NOT_TESTED；预检误拒 CONFIRMED（§11） |
| workspace-write | read-write | 允 | 允 | 拒 | 拒：F04 | 实写 NOT_TESTED；预检误拒 CONFIRMED（§11） |
| danger-full-access | read-only | 允 | 拒 | 允 | 允：F01 | **CONFIRMED** 附属根；主根/外部未执行 |
| danger-full-access | inherit | 允 | 允 | 允 | 允 | NOT_TESTED |
| danger-full-access | read-write | 允 | 允 | 允 | 允 | NOT_TESTED |

Bash、PTC 文件 SDK、batch 的上述九行均未完成实际写入矩阵；受限 confine 链是源码确认，Full-access 的局部拒写是 F03 CODE_RISK。没有给不完整矩阵涂绿色。

### 额外安全用例

| 用例 | 取证与结论 | 状态 |
| --- | --- | --- |
| 只读根在主根内部 | 两种加载顺序实际 Registry.add 均报 primary-overlap | PASS 注册拒绝；重叠执行 NOT_APPLICABLE |
| 两个附属根嵌套 | 实际注册 additional/src 报 nested | PASS 注册拒绝；嵌套执行 NOT_APPLICABLE |
| 附属根与系统 temp grant 重叠 | fixture 位于临时目录；F01 确认 Full-access 显式只读失守；WW deny 覆盖 temp 的内核验证未完成 | CONFIRMED（F01 限定）/ NOT_TESTED（WW） |
| toolAccess 指定 OPS 工具只读 / unknown tool | MR 只按 exec.name 在 tools/execute ALS 封顶；无 dispatch 且配置非空时 fail-closed。OPS 固定桥不消费该集合 | CODE_RISK；未追加写入测试 |
| Registry unavailable、竞争、移除、redirected 后写入 | 原生须分路径：fs有primary-only，shared卸载后无frame的confined/store spawn被拒（§14 A10）；OPS裸spawn不自动生成fallback | CODE_RISK；锁竞争/重定向写入 NOT_TESTED |
| 活动根撤销、mode 切换的上下文 | 真实请求更新 runtime context、发根和 Skill 撤销；历史旧消息仍保留，这是显式撤销设计 | PASS（E2） |
| authority unavailable 的完整提示词 | 最后一次卸载 Registry 在根已撤销之后执行，不能证明“仍有活动根时 authority 丢失”的提示词行为 | NOT_TESTED（该特定状态） |
| symlink / rename / hardlink / TOCTOU | OPS 原生 no-follow、父目录/leaf 检查及 CAS 存在；MR 会按 recordedPath 检查重定向。不能据此证明两者组合的重新授权 | CODE_RISK / NOT_TESTED 攻击竞态 |
| copy/move/remove 副作用 | 源/目标授权区别已核对；move 目标发布后源删除失败可报 effectState=applied；不能声称跨路径事务原子性 | 源码确认；组合动态 NOT_TESTED |
| replace 多目标 | `ops-search/src/lib.rs:240–294` 先规划，逐文件再授权/加锁/校验/发布；后续失败时已有修改通过 applied/nextAction 报告，无全批回滚承诺 | 源码确认；混合允许/拒绝目标 NOT_TESTED |
| batch 部分完成/审计 | jobs + Rust batch 有持久状态和 partial_completion/unknown；缺 MR 授权输入不能由日志机制补齐 | CODE_RISK；原子性/恢复动态 NOT_TESTED |
| 用户终端 | 无 DSH_PTY_SESSION_ID 的用户 PTY 按设计直通 | 非发现；本轮未操作用户终端 |

## 6. 发布面：不能假定每个工具到处存在

当前默认配置的本机真实 assembly（E2）与源码 O4：

| 预设 | macOS 真实 OPS Native schema | Windows / Linux 推论 | 测试边界 |
| --- | --- | --- | --- |
| Standard | ops_discover_tools、ops_glob、ops_grep、ops_inspect_local_file、ops_read_files、ops_result；官方 read 被隐藏，write/edit 保留 | 文件能力跨平台；Windows 内置额外 Bash；Linux 无内置 OPS Bash | macOS PASS；其他平台 NOT_TESTED |
| Cordis | 与 Standard 相同文件列表 | 同上 | macOS PASS；其他平台 NOT_TESTED |
| Minimal | ops_discover_tools；官方 read/write/edit 保留 | 无文件常驻基线；Windows 内置 shell 可启用 | macOS PASS；其他平台 NOT_TESTED |
| PTC | 此 Native-only 探针不发布 OPS PTC SDK，仍为原生 read/write/edit | 只有实际 single run_code + tools:ptc-only presentation 才发布 SDK，不能按 preset 名猜测 | 此负向探针 PASS；完整 PTC 安装/执行 NOT_TESTED |

此表不是完整 DSH 产品工具列表：fixture 只挂了官方文件工具，没有把未挂载的官方 glob/grep/bash、jobs 或 run_code 宣称为实际可见。当前 discovery 默认池含写工具，选择后只在下一步发布；已实际执行安全的 `select:ops_stat → 下一请求含schema → stat成功`。写工具的 dynamic 发布本轮没有追加调用。

Windows 四种内置 consumer 的 shell 还取决于各自 enabled/bash、真实 Bash runtime、policy/subprocess/jobs 服务及 gate；不能把“配置允许”当作“每个 Session 已可调用”。自定义 integration 的 shell 选择是另一条显式配置边界，本轮未验证其跨平台完整生产组合。

## 7. 上下文、指令、Skills 与 Auto Review

### 7.1 真实 provider-visible 证据

E2 的脚本挂载真实 Agents、Sessions、Projections、AgentLoop、Tools、SystemPrompt、LlmRuntime、policy、MR 两个 provider、共享 Registry 和 OPS **当前单行 Bundle**。LlmAdapter 是确定性记录适配器：不联网调用商业模型，但经过真实 prepareCall/stream 和 OPS llm/stream hooks，记录的就是适配器收到的 messages/tools。不是把 Session 原始事件当模型请求。

两种加载顺序各有 11 次请求，均无 agent/error。每次请求全文以内容寻址去重保存于 model-requests.json（本地 `model-requests.json`）：依次用 messageKeys 从 messages 表恢复，toolsKey 从 tools 表恢复；工具 Schema 和消息内容没有摘要替代。rawRequestSha256 字段是读取记录 JSON 后按键排序、紧凑序列化计算的内容哈希，不是网络报文原始字节哈希。

| 请求序列（每种加载顺序） | 模型实际可见事实 |
| --- | --- |
| 1 → 2：ops_read_files | ROOT_SENTINEL_LOOP 两次均有；NESTED_SENTINEL_LOOP 均无；读取结果成功 |
| 3 → 4 → 5：发现/执行 stat | ops_stat 第3次还没有，第4次才出现；第5次保留；不会回改当前请求 |
| 6：显式 Skill 调用 | `/additional:audit-skill` 的 SKILL_SENTINEL_LOOP 进入指令消息 |
| 7 → 8：重载 OPS 并保留官方 read | 第7次尚无嵌套指令；read 成功后第8次有 NESTED_SENTINEL_LOOP |
| 9：切 read-only | 新 runtime-context snapshot 反映新模式；之前指令/Skill 历史保留 |
| 10：根移除 | 根撤销及 Skill 不再可用的消息进入请求；最新多根上下文不再授权该根 |
| 11：Registry 卸载 | 无新工具调用；此时已无活动附属根，不用于证明活动根失联的降级 |

Multi-Root 的 `multi-root:scope` 仍由 systemPrompt.context 注册（M1:458–485），随后由宿主 runtime-context 机制发送，**不是必然作为 system role 的静态文字**。OPS 的 tool schema 发布不能等同于删除这个 context contribution。仅 MR 的 assembly 基线另由手动 context fixture 核对；完整 MR-only AgentLoop、不同产品的系统提示词 byte-identical 差分未执行。

### 7.2 F05：真正的触发缺口

M3 的 `touchedPathOfToolCall` 只认 read/write/edit 与 file_path；replay 也调用它。live fs/observed 监听仍要求 `FILE_TOUCH_TOOL_NAMES[exec.name] === true`。所以 OPS 发出 stat/observed 不足以触发发现，batch files[] 也无法用一个 observedPath 字段无损表达。

当前独立 context fixture 实际调用 ops_inspect_local_file 和 ops_read_files 都成功，观察记录存在，但 agent/pre-step messages 为空；官方真实 dsh-tool-fs 的 read 后出现嵌套指令。真实 AgentLoop 对 read_files 再确认。这里没有“先注入再删除”的证据；根级无需活动即可注入，因此照常出现。PTC 文件读取的等价缺口为源码推论，未通过实际 run_code 复现。

### 7.3 Skills

两种组合顺序的真实 `ctx.skills`：read-only 根默认 skillsEnabled=false，catalog=0；用户显式开启后 catalog=1、get 返回完整 Skill body；显式调用后 body 在模型请求中；remove 后 catalog=0 并在下一请求撤销。**模型候选内部名称**为 mr-哈希名称，用户手势为 `/additional:audit-skill`，不是把两者混为一谈。

该流程不依赖 native read/glob/grep 是否隐藏，因此这条兼容面 PASS。Skill 自身没有脚本，已测试的是内容调用，不是任意 Skill 子进程执行。存量 Session 中 OPS 卸载/重载已测；磁盘 Session 恢复后 Skills 及跨 Host 切换未测。

### 7.4 F06：Auto Review

M4:91–94 从同一个 touchedPathOfToolCall 构建当前 tool target；snapshot 又使用 M3 的活动回放。OPS 当前 path 或 files[] 可能因此漏掉“即将触达的嵌套目录链”和“此前仅被 OPS 触达的链”，相应 AGENTS.md 的路径、digest、正文约束也无法进入来源重建。不是整个附属根列表、所有根级指令或所有 Skills 自动消失。

Auto Review 是默认关闭的可选入口，精确宿主基线仍是 `0.2.1-rc.2`；本轮 `0.2.0-rc.2` 没有挂载它，因此端到端判定/批准、schema 动态发布时的审查及权限重验证 **NOT_TESTED**。不能因目标路径解析缺口而断言审批一定放行。

架构复核补充：`review-context.ts:47,96`将completeness固定为complete，漏掉OPS目标时仍作完整快照，与ADR-0021冲突。这一源码合同缺口按CODE_RISK记录，拟议修复必须在无法完整重建时技术失败，不能返回一个现有schema不支持的incomplete快照。见§14 A7。

### 7.5 读取去重与 compaction

O5 只有自己拥有的成功 top-level read、opaque execution token、durable message 身份、精确 assistant call/参数和最新成功普通 provider 请求都匹配时，才通过工具 finalizeContent 返回精简正文。它不改 messages 数组，也不删 user-form instructions；purpose=compaction/title 不建立证明。surface.contentGeneration、mode 变化、未知/变更工具结果和组件卸载会丢弃证据；读 IO 仍执行。

当前 OPS 的真实 LLM/Session/Worker 回归：dedup 17项、read_files 5项通过，覆盖首次/重复读取、文件修改和身份替换、范围变化、mode、真实 surface replacement（compaction 机制）、message projection、并发、辅助请求、卸载与完整 PTC canonical value。v0.4.4 的 dedup 17项也通过。**这些是 OPS 独立回归，不冒充每项都带 MR 的组合测试**；组合根/Skill 可见性由 E2 补证。

没有运行真实外部 compactor 的摘要质量、跨进程磁盘恢复、真实付费模型请求或 billing token 统计。没有宣称节省百分比。官方工具恢复会增加 Schema 集合；确切 billing/token 代价未测，不能引用历史 README 的百分比。

## 8. 动态测试记录与缺口

| 测试记录 | 已执行结果 | 分类与范围 |
| --- | --- | --- |
| E1 Native 最小写入 | 原生拒绝且无副作用；OPS成功且磁盘哈希改变 | F01 CONFIRMED；仅一次潜在越权写入 |
| E2 两种顺序真实 AgentLoop | 各11次记录请求，无 agent/error；技能、发现、卸载/重载、切模式、根撤销、重叠注册 | PASS / F05 CONFIRMED；不等同完整产品 profile 安装认证 |
| E3 独立 context fixture | inspect/read_files 均产生观察但不注入嵌套指令；官方read后注入 | F05 CONFIRMED；完整循环另由E2验证read_files |
| E4 Bash链 spy | command、script_path 均产生裸 argv；confine未调用；**无真实进程执行** | PASS 入口分支探针；P0越权仍CODE_RISK |
| E5 当前 OPS 第一组 | consumer-assembly 17、dedup 17、read_files 5、session-lifecycle 3通过；discovery-composition两个场景失败 | 4 suites PASS；1 suite受环境阻断，不算PASS |
| E5 当前 OPS 第二组 | adapter-boundary 3、discovery-incremental 14、probe-memo 2、official-tool-hiding 33、platform-defaults 6、preset-integration 7通过 | 6 suites PASS；OPS自身回归 |
| E5 OPS v0.4.4 | compat-alias 4、dedup 17通过；独立TS/Rust构建完成 | 2 suites PASS；没有重做越权写入 |
| 受限 native shell/run_code 内核执行 | 两个 discovery-composition 场景均报 `sandbox-exec: sandbox_apply: Operation not permitted` | NOT_TESTED 有效内核行为；未扩大外层权限 |
| Windows ACL/OPS Bash、Linux bwrap/Landlock | 当前机器不提供对应隔离内核 | NOT_TESTED；只有源码链推断 |
| 真实 desktop/web/headless/TUI profile co-install | 未运行 CLI profile 安装或用户产品 | NOT_TESTED |
| 多进程 lease 竞争、owner失联与 takeover；活动根重定向竞态 | 未扩大P0写入验证 | NOT_TESTED |
| PTC SDK/provider请求、batch混合目标部分副作用 | 已静态追踪；受限 run_code验证阻断 | NOT_TESTED 组合执行 |
| MR 卸载时仍有活动 OPS 调用、恢复未完成job | 未测试 | NOT_TESTED；不能以整个fixture正常dispose代替 |
| OPS动态加载失败/官方回退 | OPS现有 preset-integration 与 hiding 回归通过；组合下故障注入未执行 | 单插件PASS；组合NOT_TESTED |
| 新/存量/磁盘恢复 Session | 新建Session、同Session工具动态发布与OPS重载已测；磁盘恢复未测 | 部分PASS；恢复NOT_TESTED |

构建 Worker SHA256：当前 `922fb6a2499796bc3812c6e492f7ea2343da84cb9ec79b6b0b5062815b839e01`；v0.4.4 `d0623fdfd9d67bdb26353fb632101e32db564f501f7ff2301f0faff8b5ff697e`。均由锁定 Cargo 依赖、对应 tag/commit 源码在本机构建，未替换业务实现。

### 可重复运行方式

证据脚本使用 Node transform-types 直接载入 MR 原源码；OPS 使用其构建产物。它们是审计夹具，不是插件补丁。先把两仓目标 git archive 放到以下临时布局，将证据脚本复制到 ops-current 中；不要在原仓库改 pin。

```text
/private/tmp/dsh-ops-compat-audit/
  multi-root/       # git archive 4e45e25...
  ops-current/      # git archive 2c0b039...
  ops-044/          # git archive fc11890...
```

```sh
# 在临时 ops-current 中
npm ci --ignore-scripts --no-audit --no-fund --cache ../npm-cache
npm install --ignore-scripts --no-save --no-audit --no-fund --cache ../npm-cache \
  @deepseek-ai/dsh-fs@0.2.0-rc.2 @deepseek-ai/dsh-fs-sandbox@0.2.0-rc.2 \
  @deepseek-ai/dsh-sandbox-policy@0.2.0-rc.2 \
  @deepseek-ai/dsh-storage-domain@0.2.0-rc.2 @deepseek-ai/dsh-storage-json@0.2.0-rc.2 \
  @deepseek-ai/dsh-agent-instructions@0.2.0-rc.2 \
  @deepseek-ai/dsh-skill@0.2.0-rc.2 @deepseek-ai/dsh-skill-filesystem@0.2.0-rc.2 \
  @deepseek-ai/dsh-session-projection@0.2.0-rc.2 \
  @deepseek-ai/node-addon-system@0.1.2 koffi@3.1.0 zod@4.6.7
npm run build
CARGO_HOME=/private/tmp/dsh-ops-compat-audit/cargo-cache \
  cargo build --release --locked --manifest-path native/Cargo.toml
node bin/native-runtime.mjs stage --platform darwin-arm64
ln -s ../ops-current/node_modules ../multi-root/node_modules
DSH_HOME=/private/tmp/dsh-ops-compat-audit/home node --experimental-transform-types p0-repro.mjs
DSH_HOME=/private/tmp/dsh-ops-compat-audit/home node --experimental-transform-types loop-audit.mjs
node bash-chain-probe.mjs
```

p0-repro 会写其**自己创建**的临时标记文件，仅在获授权的隔离复核中运行。loop-audit 只读取业务fixture，Registry/Session与Skill元数据写入也都限于临时目录。两个原仓库未被安装依赖/编译污染。完整宿主版本清单见 host-versions.json（本地 `host-versions.json`）。

## 9. 建议修复归属：本轮不实施

| 对应发现 | 选择与最小修改面 | 兼容成本 / 必须回归 / 不得破坏 |
| --- | --- | --- |
| F01/F02/F04 | **OPS 上游 + 双方协作契约**：在 execution/files 的真实副作用入口消费可信、逐操作的宿主授权；Multi-Root 可提供经审查的授权接缝。OPS 不应从可序列化旧snapshot或模型参数自行拼第二套scope | 覆盖三态×三模式、cap、authority丢失、epoch/realpath变化、copy源/目标、replace多目标。保留主根/普通外部按mode、读不被写限制变成读隔离、credential fence、CAS/no-follow；RW附属根在RO模式必须可用 |
| F03 | **OPS 上游 + 双方进程授权契约**：明确 Bash 与 Worker 全模式的 launch admission/profile责任；Full-access有局部deny时也取得有效执行授权 | Windows真实ops_bash command/script_path、Linux/macOS显式consumer、受限full/partial、原生shell对照、PTC RPC ALS继承与内层证明失配、原生同步spawn返回形状、取消和权限降级。不要只加“总是confine”而改变Full-access全局语义；不要按argv猜tool身份 |
| F05 | **Multi-Root 自行适配**：在现有 compat/instruction-activity 单点正规化OPS成功活动；从一个target扩为受界限的多target；live由MR适配，replay须先过DSH安全记录API门槛（§14 A1） | 测inspect/path、read_files/files[]逐项成功/失败、failed whole result、相对cwd、PTC durable activity、resume、目录祖先链、撤销和总字节预算；不得把任意工具参数名path都视为可信成功访问；上游可提供标准成功文件活动事件 |
| F06 | **Multi-Root 自行适配**：复用F05的多target正规化更新review target与replay，不独立复制识别规则 | 在精确Auto Review宿主0.2.1-rc.2验证当前目标、历史OPS-only目录、根级/嵌套指令digest与来源；不把“缺target”默认为完整审查，也不改变默认关闭和精确兼容门禁 |
| P01/P02/P03 | **无需改动已正确的路径**；继续保留schema作用域、延迟发布、独立Skills provider、dedup的正证据要求 | 追加组合回归即可；不要为不存在的“OPS压缩全部上下文”引入消息猴子补丁；不复制OPS publication或重写shared tools registry |
| 文档漂移 | OPS 上游同步内置Bash平台范围与当前兼容配置说明 | 区分内置Windows门控、自定义consumer、已发布0.4.4和0.5候选；不扩大未测试平台支持承诺 |

仅 MR 增加 ops_* 指令识别**不能修复 F01**；仅关闭官方工具隐藏也不能修复 Native 写入安全。支持范围认证仍须补 Windows/Linux、本机原生内核环境、完整 PTC 和 Auto Review 精确宿主验证。没有证据支持通过猴子补丁统一拦截任意 subprocess 或复制另一套授权逻辑作为本轮建议实现。

## 10. 源码与测试证据索引

所有行号以本报告固定 commit/tag 或隔离安装包为准。源码编号摘录（含每个源文件 SHA256）统一保存在 source-excerpts.txt（本地 `source-excerpts.txt`），避免依赖未来 main。

- **M1**：[scope.ts](../../src/scope.ts) `430–485, 525–605`；[fs.ts](../../src/fs.ts) `91–129, 147–223`：cap、context、writable/deny、原生写栅栏。
- **M2**：[process-fence.ts](../../src/process-fence.ts) `115–176, 240–282`：工具admission与PreparedDeny分离、spawn与shell/PTC入口；[sandbox.ts](../../src/sandbox.ts) `90–109`：受限confine。
- **M3**：[instruction-activity.ts](../../src/compat/instruction-activity.ts) `45–107`；[instructions.ts](../../src/instructions.ts) `315–343, 399–418`：live/replay与观察白名单。
- **M4**：[review-context.ts](../../src/review-context.ts) `60–99`：实际授权环境、当前target和来源快照。
- **M5**：[skills.ts](../../src/skills.ts) `86–109`；[catalog.ts](../../src/skills/catalog.ts) `33–43, 55–114`；[invocation.ts](../../src/skills/invocation.ts) `10–62`：枚举、加载、用户手势和撤销。
- **M6**：[roots.ts](../../src/roots.ts) `339–379`：拒绝主根重叠/嵌套。
- **O1**：[OPS files.ts@2c0b039](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/execution/files.ts#L108) `41–74, 108–220`；[authority-paths.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/authority-paths.ts#L16) `16–29`；旧版 [worker.ts@fc11890](https://github.com/T-Auto/dsh-ops/blob/fc11890f7668c9912fcde1df1ca89810e1cbc031/src/file/worker.ts#L99) `99–194`。
- **O2**：[OPS session-execution.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/shells/session-execution.ts#L10) `10–41`；[shells/execution.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/shells/execution.ts#L70) `70–100`；[shells/tool.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/shells/tool.ts#L70) `70–76, 275–338`。
- **O3**：[OPS jobs.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/execution/jobs.ts#L59) `59–143`；[monitored.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/execution/monitored.ts#L18) `18–24`；[publication/ptc.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/publication/ptc.ts#L48) `48–65, 107–125`。
- **O4**：[OPS builtin.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/presets/builtin.ts#L26) `26–44`；[defaults.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/presets/defaults.ts#L37) `37–48`；[replacements.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/publication/replacements.ts#L95) `95–100`。
- **O5**：[OPS read-dedup.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/projections/native/read-dedup.ts#L37) `37–132`；[read-evidence.ts](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/src/projections/native/read-evidence.ts#L35) `35–60`。
- **O6**：[OPS file_single.rs](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/native/crates/ops-files/src/file_single.rs#L171) `171–203, 318–349, 480–483, 580–610`；[file_publication.rs](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/native/crates/ops-files/src/file_publication.rs#L82) `82–93`；[ops-search lib.rs](https://github.com/T-Auto/dsh-ops/blob/2c0b0397ce4b48436ff76cf5c5b039054240a45c/native/crates/ops-search/src/lib.rs#L240) `240–294`。
- **E1**：P0结果（本地 `p0-results.json`） 与 最小复现脚本（本地 `p0-repro.mjs`）。
- **E2**：真实模型请求与组合结果（本地 `model-requests.json`） 与 组合脚本（本地 `loop-audit.mjs`）。
- **E3**：独立context结果（本地 `context-results.json`） 与 context脚本（本地 `context-probe.mjs`）。此夹具手动驱动 pre-step/assembly，用于 inspect/read_files 及 MR-only assembly 对照；不将它手工构造的发送步骤当成真实 AgentLoop 请求，模型请求结论以E2为准。
- **E4**：Bash入口探针结果（本地 `bash-chain-results.json`） 与 探针脚本（本地 `bash-chain-probe.mjs`）。
- **E5**：当前OPS第一组原始日志（本地 `ops-current-tests.log`）、生命周期/发布回归日志（本地 `ops-current-lifecycle.log`）、v0.4.4回归日志（本地 `ops-v044-tests.log`）。
- **E6**：源码与宿主安装包编号摘录（本地 `source-excerpts.txt`）、宿主版本清单（本地 `host-versions.json`）。

## 11. ADR 起草阶段补充取证

本节补充本次后续评审准备的结果，前文首次审计的证据范围保持可追溯。未执行新的潜在越权实写；以下 OPS 调用全部是 `ops_write_file` 的 `dryRun: true`，每次前后目标文件 SHA256 相同。宿主与源码仍为 §2 的统一测试版本。

| 用例 | 实际结果 | 对原发现的补充 |
| --- | --- | --- |
| workspace-write + inherit 附属根 | MR preview 的 writableRoots 包含该根；OPS 在 preflight 返回 POLICY_DENIED | F04 的**误拒预检 CONFIRMED**；实际写入路径仍未测 |
| workspace-write + 固定 read-write 附属根 | 同上 | 同上 |
| read-only + 固定 read-write 附属根 | MR 允许该附属根；OPS 仍按全局 read-only 拒绝 | 同上 |
| read-only + read-only 对照 | OPS 拒绝 | PASS 拒绝预检；未执行实写 |
| workspace-write 主根对照 | OPS 完成 dry-run，changed=0 | PASS；排除 runtime 不可用导致所有请求失败 |
| Full-access + toolAccess 将 ops_write_file 封为只读 | 活跃 admission 中 writableRoots=[]、deniedRoots 包含附属根，但 Worker 仍以裸 argv 启动，dry-run 完成 | F02 的**执行链缺口 CONFIRMED**；cap 越权实写仍为 CODE_RISK |
| Full-access + 卸载 Registry | scope authority=unavailable、hasAdmission=false，但同一 OPS dry-run 仍裸启动并完成 | F02 的**失权后裸启动 CONFIRMED**；不可用/锁竞争的真实写入矩阵未测 |

证据：可写根预检结果（本地 `writable-root-results.json`）、预检脚本（本地 `writable-root-probe.mjs`）、风险复核结果（本地 `risk-reanalysis-results.json`）、复核脚本（本地 `risk-reanalysis-probe.mjs`）。在原临时 ops-current 布局，以临时 DSH_HOME 和 `node --experimental-transform-types` 运行即可复核。

重新分析时还有两条方案约束：

1. Registry admission 已经发生，不代表 deny profile 已经安装；但已准入操作可按 ADR-0024 使用当次快照完成，不能把准入后合法撤权一概叫作绕过。独立新调用、过期异步后代及新进程才需要对应的新准入/有效启动上下文。
2. OPS `deny_roots` 由 `ops-protocol/src/lib.rs:125–145` 用于**拒绝读取和遍历**的 credential fence。不能直接将 Multi-Root 的写入 deniedRoots 填进去，否则会把只读附属根变成不可读。写授权桥必须区分 write-deny 与 read-deny；当前公开 integration/options 没有能替换固定文件授权算法的 hook，单靠扩大内核 grant 无法撤销 OPS 预检的误拒。

待评审方案见 [ADR-0027](../decisions/ADR-0027-ops-file-authorization-and-activity-adapter.md)。该链接只表示存在 Proposed 提案，不表示已适配或已接受。

## 12. 独立评审后的合同与证据复核（2026-11-01）

已按独立评审R1–R11对照当前源码与既有记录做局部修订，**审计F01/F05等确认结论无需撤回，ADR-0027仍为Proposed**。没有实施适配器，也没有以合同修改代替适配后V1–V7验证。

### 12.1 证据身份与确认程度

- E1、E3、writable-root、risk-reanalysis使用合成Agent对象及夹具agents/preset索引；Session、工具注册/分发、policy、fs/sandbox、Storage、共享Registry是真实服务，同一Agent对象贯穿调用。它们没有证明真实AgentRegistry的所有身份管理路径；P0文件副作用结论不因此撤回。
- **E2 loop-audit使用ctx.agents.create产生真实AgentRegistry实体**，不能把它和合成Agent夹具一概归类。22次provider请求的服务链及消息记录保持原结论。
- FA+cap与FA+失权的机制已演示到“真实OPS授权预检通过、实际裸Worker启动、dry-run成功”这一步，与F01共用固定文件写桥。仍保留实际cap/失权写入为CODE_RISK，因为没有执行最后的字节落地；不意味着整个机制仍只是模糊猜测。
- `ops_move`源删除和`ops_remove`删除同属mutation写面，文件族均为mutates；其源侧删除必须受同一写边界保护，不能只检查copy/move目标。实际删除用例仍NOT_TESTED。
- batch/result在execution/jobs.ts:78–91和119–124还有全局RO/operationRoot/requiredMode闸门，属于F04同族误拒风险；当前三项预检CONFIRMED来自固定文件工具，不扩大为batch动态确认。

### 12.2 需要纠正的评审概括

| 评审建议中的概括 | 实际源码与本次修订 |
| --- | --- |
| authority unavailable/redirected/none的分支 | scope.ts:117仅有available/unavailable；redirected是RootState。ADR以实际类型列触发表，不引入none |
| writableRoots=0即可放行 | 不成立：cap探针正是空writable+非空deny。必须看authority、真实mode和deny；受限mode的零附属根也不免除基本限制 |
| OPS WW/RO已由confine保护 | Bash与jobs确有confine，**execution/files没有**，Native/PTC固定文件需要补执行边界。不能按mode忽略执行桥差异 |
| monitored.ts负责所述RO平拒，files.ts存在effective.additional字段 | 当前monitored主要按FILE_TOOLS路由；files没有该字段。ADR逐个列真实host、envelope、jobs和Rust闸门 |
| WW+固定RW将因Rust read_only=true而拒 | 当前WW envelope中read_only=false，实际已在host拒；只有不完整修复RO+固定RW时才会遇到下游read_only平拒 |
| 所有fixture的Agent均合成 | E2通过真实AgentRegistry创建，见12.1 |
| next()返回后即可记录最终成功 | dispatch之后还有post-execute和finalizeContent，可能改成失败/替换value；采用最终tools/result锚点，见12.3 |
| purge就是admission外host ambient写、可直接视为可接受 | POSIX cache mkdir是host fs，purge则会新spawn Worker；二者应分别列明。是否允许maintenance例外仍待评审，尤其私有temp与MR deny重叠时不能静默豁免 |

以上修订不否定评审的主要方向，而是避免将概括或错配行号变成实现合同。

### 12.3 最终结果与事件提交接缝：补充最小探针

记录见 event-contract-results.json（本地 `event-contract-results.json`），脚本见 event-contract-probe.mjs（本地 `event-contract-probe.mjs`）。它使用真实DSH 0.2.0-rc.2 Tools/Session、合成Agent与无文件IO的合成工具，仅验证公开结果/Session事件接缝，不是OPS适配实现或完整AgentLoop测试。

| 探针 | 实际观察 | 状态 |
| --- | --- | --- |
| 工具返回completed，post-execute阻断 | tools/execute的next返回isError=false/status=completed，最终tools/result却isError=true | CONFIRMED：dispatch-return不是最终成功 |
| 工具返回rejected对象 | 最终isError=false/status=rejected | CONFIRMED：isError=false不等于成功触达；实际OPS拒绝形状另由§11记录证实 |
| tools/result观察器同步append插件事件 | 成功，插件事件seq=0，随后调用方append普通tool/result的seq=1 | PASS仅限内存提交顺序；撤回持久化可用结论，未知非ignorable事件被读取校验拒绝（§14 A1） |
| session/event发布监听内再次append | 抛出`session append cannot reenter while another append is being published` | CONFIRMED：不得同步重入 |

Phase A的最终canonical结果与逐项live识别仍可据此设计。Phase B的普通session.append自有type方案已在§14 A1撤回：提交顺序成立，但0.2.0-rc.2读取校验拒绝此事件，不能作为持久化依据。安全ignorable API、真实jsonl重开/卸载与迁移必须另验；早期两版Phase B当前不适用。原结果文件保留为内存实验记录。

复跑方式：在原临时ops-current布局执行以下命令；DSH_HOME由系统临时目录生成，满足OPS测试harness约束。

```sh
DSH_HOME="$(mktemp -d)" node event-contract-probe.mjs
```

### 12.4 覆盖声明仍有边界

完整静态spawn清单及归属义务放在ADR D1.4。重要补充是：resultStorage purge可能在session disposal/component unload之后的独立清理域启动；Windows WW的workspace-preparation还使用直接node:child_process.spawn，涉及ACL准备与backup，**不经过MR subprocess包装**。这不是本轮动态确认的新越权，而是不能从“所有Worker都在dispatch ALS内”推导完整保护的具体缺口。

OPS src中其他settings runtime action、install/provision/build/upgrade/CLI review等进程位点也已列入清单，需靠调用图和operator admission证据排除，不能只按文件名判断。Rust固定Worker的当前源码检索未见子进程启动；未来版本仍需重新枚举。当前monitored batch同步run且await work，不再假设其返回后respawn；后台Bash、purge、Windows准备与cleanup/deny重叠仍需独立动态验证（§14 A6）。

保护模式对authority unavailable的可能写盘OPS调用（含读Worker）拟在OPS invoke/prepare/cache正文之前拒绝；这依赖待实现适配器的早拒，不是当前spawn包装已经提供的能力。原生fs的primary-only与shared卸载后无frame进程拒绝须区分，见§14 A10。maintenance私有目录例外只列为**待审残余**，不得借此豁免任意裸Worker或允许跨越显式写拒根。

源码编号与SHA256补证见 review-source-excerpts.txt（本地 `review-source-excerpts.txt`）。独立评审R1–R11逐项处理结果在[ADR的评审处理记录](../decisions/ADR-0027-ops-file-authorization-and-activity-adapter.md#独立评审处理记录)；V1–V7仍是后续原型/上游/平台验收义务，未因本轮修订升级为PASS。

## 13. 第二轮评审：N1–N4 局部复核（2026-11-01）

### 13.1 N1 / F07：confine 后的 cache bind 与严格证明冲突

源码链成立：OPS `execution/jobs.ts:99–110` 先取得MR confine输出，随后 `exposePosixCache` 可能改写argv；MR `registry-operation.ts:112–122`记忆原argv，逐元素要求它是启动argv的前缀，`process-fence.ts:167–176`在shared admission下拒绝不属于本次证明的confined启动。

但触发条件需要精确到函数predicate：`basename(argv[0]) === 'bwrap'`、有separator、separator前出现`--tmpfs`或`--tmpfs=`、storage存在、不是Windows SID cache且root为绝对路径，才会在`--`前插入`--bind cache cache`。上游0.2.0-rc.2的bwrap WW profile固定带tmpfs，所以共享模式下**全部到达该启动分支并取得有效cache的WW batch/result**都会失配，含page；不能把它写成WW下偶发组合。**不带tmpfs的常规RO、Landlock或无storage对照不触发**。POSIX cache位置不依赖confine结果，前置声明没有循环依赖；Windows位置虽依赖confine，却不走此bind分支。

本轮运行了无进程结构探针：从OPS原始TypeScript提取该函数并仅做TypeScript语法编译，调用真实MR `runRegistryOperation/rememberOperationProfile/operationPermitsProfile`；使用代表性argv，不运行bwrap、不启动Worker、不读写业务fixture。没有修改任何插件源码。

| 代表性argv条件 | 改写前归属 | OPS变换后归属 | 结论 |
| --- | --- | --- | --- |
| bwrap + tmpfs + cache | true | false | CONFIRMED：函数级prefix冲突 |
| bwrap + `--tmpfs=/tmp` + cache | true | false | CONFIRMED：同一predicate分支 |
| bwrap，无tmpfs | true | true | PASS：变换对照不改argv |
| bwrap + tmpfs，无storage | true | true | PASS：变换对照不改argv |
| Seatbelt argv + cache | true | true | PASS：非bwrap变换对照 |

这不把代表性profile当成Linux provider实测。**真实Linux batch/result误拒、具体工具错误与内核效果仍为CODE_RISK / NOT_TESTED**；函数关系已经动态复现。旧版严格证明会拒绝该改写，因此“新增bind可能覆盖更早的ro-bind”是放宽校验或无证明执行时的风险，不能写作当前组合已成功绕过deny。

拟议处置选择“最终profile生成前审批cache需求，最终argv一次生成并记忆；下游不再修改执行约束”。不为兼容而跳过bind、忽略extra flags、无条件重登记argv，或笼统改成结构等价。需要OPS公开cache需求接缝，与D3协同；旧OPS安全拒绝时明确标为未完整兼容。真实Linux验证进入ADR V8。

证据：cache-profile-results.json（本地 `cache-profile-results.json`）、探针脚本（本地 `cache-profile-probe.mjs`）、源码行号与SHA256（本地 `cache-profile-source-excerpts.txt`）。在MR仓库根目录、相邻为原OPS检出目录且本仓有TypeScript依赖时：

```sh
node --experimental-transform-types docs/reviews/dsh-ops-audit-evidence/cache-profile-probe.mjs
```

脚本可接OPS仓库路径和输出文件作为两个参数；默认结果保存在系统临时目录。转换后的函数未改业务逻辑，证据分别保存整个源文件和函数片段哈希；原函数边界变化时脚本拒绝继续。

### 13.2 N2–N4：合同补充

| 评审项 | 源码核对与修订 | 验证范围 |
| --- | --- | --- |
| N2 私有写区域 | 明确盘点当前Session temp、result cache和operationRoot下audit store；cache/temp位于realpath(tmpdir)下不等于获得写授权。最终profile需审查可见性、私有归属、tmpfs遮蔽与deny-on-temp优先。RO不凭空获得temp写权限；host mkdir与purge另行约束 | 源码核对；适配后profile与内核副作用NOT_TESTED，新增V9 |
| N3 mutation集合 | FILE_MUTATIONS六种写族；batch plan/run/resume；result区分Native page/release与PTC put/page/release；page业务读取不因粗粒度mutates=true被一刀切拒，准备/maintenance不因此豁免；shell按可能写入处理 | 来源是实际能力Schema与执行桥；不是把模型参数当权威。适配后行为待验 |
| N4 准备后复查 | 复用本次已准入快照，不在spawn前重取Registry epoch或悄悄重新准入；仍检查本次路径身份、profile有效期和真实policy变化。需重试时先结束旧操作，再新调用 | ADR-0024合同澄清，无新增实际授权测试 |

ADR仍为Proposed。第二轮N1–N4的处理摘要在其评审记录，原型义务由V1–V7扩展至V8/V9；本轮结构探针不构成Linux兼容认证、适配实现或接受ADR。


### 13.3 第三轮评审后的当前限制披露

F07属于**现存代码组合的兼容缺陷**，不依赖ADR-0027是否实施。当前默认bundle启用sharedStorageRoot，满足§13.1的bwrap/tmpfs/cache条件时，严格证明可拒绝已改写argv；page虽是业务读动作，也可能经同一jobs/cache路径触发。函数级冲突已有证据；Linux端到端仍为CODE_RISK / NOT_TESTED，常规无tmpfs的RO profile等对照不被扩大为受影响。

已在[中文README已知限制](../../README.md#已知限制)与[英文README Known Limitations](../../README.en.md#known-limitations)披露该车道降级。等待OPS公开confine前cache需求接缝期间，状态是**安全拒绝方向的误拒、尚未完整兼容**，没有干净且已验证的MR单侧临时缓解；不得以放宽profile校验或删除deny冒充修复。ADR D5已按车道明确双方责任。

ADR继续保持Proposed；第三轮“建议接受”不代替维护者决策。V6/V9拟共用deny覆盖tmpdir祖先的固定夹具，OPS升级复核须重跑cache-profile探针；这些是后续验证义务，本轮没有新增适配实现、Linux内核结果或发布声明，也不改写已发布版本的CHANGELOG历史。

## 14. 独立架构审计A1–A13复核

2026-11-01收到另一份独立架构审计后重新核对。MR仍为4e45e25、OPS仍为2c0b039且OPS工作树干净；本仓src未改。审计指出的A1/A2足以撤回此前部分可实施性结论，A3要求拆分WW/RO路线，A4改变PTC特定组合的风险分类。ADR继续Proposed；修正文档不构成维护者接受、适配实现或新的完整兼容声明。

本轮读取了外部审计临时目录中下载的精确DSH发布包，并确认执行用session/session-persistence均为0.2.0-rc.2；没有使用本仓0.2.2-alpha.2安装树冒充OPS有效宿主。原E1/E2/§11未重跑。源码与哈希已保存为architecture-source-excerpts.txt（本地 `architecture-source-excerpts.txt`），临时目录不再是这些结论唯一的证据位置。

### 14.1 逐项结论与处置

| 项 | 复核结果及证据等级 | 源码/探针依据 | 文档处置与归属 |
| --- | --- | --- | --- |
| A1 持久事件 | **CONFIRMED（函数级）**：真实Session.append即使传ignorable选项也不保存；实际读取校验拒绝其未知事件。完整jsonl重开NOT_TESTED | session 0.2.0-rc.2:1441–1460；persistence:182–185；jsonl:1818/2720/2824；本轮探针 | 撤回§12.3的持久化PASS，只保留内存顺序PASS。ADR D2.2删除普通append退路；0.2.0-rc.2/0.2.1-alpha.1当前Phase B NOT_APPLICABLE。MR设计 + DSH API |
| A2 读也写盘 | **CODE_RISK**：业务page非RO可创建operationRoot下.dsh-ops/lock；读工具可准备/写cache；实写未测 | OPS jobs.ts:74–79,111；native/src/lib.rs:45–65；ops-results/store.rs:21–44；result-storage.ts:111–137 | D1 FA所有Worker均纳入，不按mutation豁免；host准备须正文前检查/早拒。PTC目前可能先被A4阻止，不能把该链直接升级为已复现越权。MR主修 |
| A3 WW/RO profile | **CODE_RISK / 原型NOT_TESTED**：bwrap WW固定tmpfs遮蔽/tmp，MR没有公开精确cache nonce；Windows还有私有准备 | sandbox-local:22–39；session-temp.ts:25–33；result-storage.ts:111–137；files.ts:145–179 | 撤回MR单侧全模式profile承诺。D1.1d列OPS应用层信任与上游私有区域声明两路线，均待决；不直接接受“只剩两个例外”的完整证明，cache/host准备/路径身份也必须覆盖 |
| A4 内层证明 | **CONFIRMED（函数级）**外层true、内层false、内层重新记忆true；一般Node pipe回调保留ALS。特定shared FA有deny链源码判定安全拒绝，完整PTC+OPS **NOT_TESTED** | registry-operation.ts:112–122；process-fence.ts:116–119,167–176,245–263；ptc-runtime-node:961–989 | D4撤回该条件下笼统待定，D1最内层frame准备并覆盖store。不能泛化所有PTC/legacy组合。MR |
| A5 顺序/缺席 | **CODE_RISK**：scope cap与process admission是独立hook，单行重载可能改变顺序；保护缺席可留下裸入口 | scope.ts:448–451；process-fence.ts:116–119；registry.ts:301的现有依赖 | D1.3同监听器、同cap上下文及生命周期门禁。仅让Registry“不发布拒写根”不够：删除deny可恢复ambient；必须阻止新OPS调用、保留负边界、drain后再卸载。反向inject只是候选启动门禁，依赖图/拆卸未验。MR |
| A6 调度外启动 | **CODE_RISK**：shared WW无frame的purge被证明闸门拒绝，清理回调告警且不自动重试；后台Bash有过期启动风险。真实清理/Windows未测 | result-storage.ts:88–104；result-lifecycle.ts:66–97；shells/jobs.ts:28–33、host-tool.ts:88；jobs-local:437；monitored.ts:28–45 | 记录cache可能残留。保护原型早拒run_in_background或等上游独立入口。微任务本身不证明必然晚于工具返回，不认定“每次后台都失败”；当前batch同步run且await work，收窄V3。MR + OPS |
| A7 complete | **CODE_RISK（源码合同缺口）**：遗漏目标仍返回complete，违背ADR-0021；实际审批NOT_TESTED | review-context.ts:47,91–96；ADR-0021“只返回complete” | F06措辞升级为合同缺口；不能完整发现时技术失败，不新增incomplete schema。MR |
| A8 根身份 | **CODE_RISK（桥设计缺项）**：现有Rust重新canonicalize授权根；拟议附属根桥不能让grant随新链接移动。未做竞态实写 | file_single.rs:171–203；ops-batch/lib.rs:93；ops-protocol/lib.rs:157 | D3要求canonical根等于传入记录值，deny词法/规范双边界；batch新增逐写授权。官方deny_unknown_fields为正面拒绝行为，不能替代自定义Worker协商。双方合同 + OPS |
| A9 F07范围 | **CODE_RISK（组合）；函数冲突CONFIRMED**，不是WW bwrap中偶发配置 | sandbox-local:22–39；jobs.ts:99–110；result-storage.ts:52–70,111–137 | shared+bwrap WW中所有到达该分支且有storage的batch/result都会失配；无storage/普通RO/Landlock不扩大。POSIX前置cache需求无循环依赖。README与§13.1同步 |
| A10 原生降级 | **CODE_RISK（具体生命周期）；无frame证明拒绝CONFIRMED函数级**。共享卸载后admissionProof不清除，confined/store spawn不能获得许可 | scope.ts:496–506,524–535；registry.ts:379；process-fence.ts:167–176 | 修正原生一律primary-only说法：fs仍有该降级，共享无frame进程拒绝；legacy/仍有fallback operation另分。不要扩大为所有subprocess/用户终端都全拒 |
| A11 已知限制 | **PASS（文档复核）**：原README只披露F07，未向读者直接披露F01/F04/F05 | 原审计F01实际副作用、§11三种预检、E2真实loop | 双语README补F01/F04/F05并限定通用fs/bash承诺；不是撤销此前实测 |
| A12 观察/行号 | **PASS（源码核对）**：读观察执行前resolve/stat、成功后发出，只佐证host请求路径 | files.ts:191–215 | D2.1不再称其证明实际对象；RO平拒定位155，生命周期66–97，证明112–122 |
| A13 可用性 | **CODE_RISK（拟议方案代价）**：legacy竞争失权时，早拒也拒绝主根OPS写 | D1失权规则；registry.ts竞争降级路径 | D1/D6明确代价，不能当成已实现行为；保留维护者接受条件 |

### 14.2 本轮独立复跑记录

脚本：architecture-contract-probe.mjs（本地 `architecture-contract-probe.mjs`）；结果：architecture-contract-results.json（本地 `architecture-contract-results.json`）。在隔离目录已安装精确的session/session-persistence 0.2.0-rc.2时：

```sh
node --experimental-transform-types docs/reviews/dsh-ops-audit-evidence/architecture-contract-probe.mjs <isolated-host-directory>
```

脚本检查实际manifest与源文件SHA256，调用真实公开Session.append、validateStoredEvents和本仓registry-operation函数，不复制判定算法。唯一子进程是输出固定marker的Node，用于检查stdout回调ALS继承；它不是OPS Worker、PTC运行时或sandbox runner。本轮未运行Linux/Windows内核、未写业务fixture、未修改上游包。最初夹具传了不完整Session header而被构造器拒绝，改为公开默认构造后，以下断言全数通过；该夹具错误不计产品发现。

| 观察 | 结果 | 可支持的结论 |
| --- | --- | --- |
| append自有事件，并传ignorable选项 | 事件没有ignorable；读取校验抛SessionFormatUnsupportedError | CONFIRMED：普通append不是安全持久插件事件API |
| 同一事件对象副本加ignorable:true送校验器 | 接受 | PASS：读取器认可信封标记；不是公开写API存在的证明 |
| 外层remember/permit | true | PASS：有效证明对照 |
| 内层frame复用外层prefix | false；内层独立remember后true | CONFIRMED：归属按frame隔离，支持内层准备方向但非适配实现验收 |
| cap不一致；frame之外使用 | 均false | PASS：证明不跨cap或失活边界 |
| 通用Node子进程stdout回调的ALS | 保留outer-frame | PASS：异步资源继承对照；完整PTC链未跑 |

另静态检查已下载session产物：0.2.0-rc.2/0.2.1-alpha.1无appendPluginRecord，alpha.2及抽验alpha.3/alpha.5/rc.1/rc.3/rc.5有；上游注释明确experimental调用限制。没有因此承诺整个版本交集都支持Phase B，也没有调用该API写真实会话。外部审计“无进程探针”的称呼须更正：其nested-proof脚本也启动了仅输出marker的Node子进程，准确范围是无OPS Worker/无业务写。

### 14.3 追加验证义务与原型范围

| 实验 | 当前证据/缺口 | 后续决定性观察 |
| --- | --- | --- |
| X1：普通事件与plugin record的jsonl重开 | 普通append+实际校验器已函数级拒绝；完整jsonl重开、0.2.1-rc.2安全record及卸载重开NOT_TESTED | 前者明确拒绝；后者安装/卸载均可读，迁移/崩溃语义成立才开放Phase B |
| X2：run_code内ops_inspect_local_file | 嵌套证明与通用pipe已函数级复现；完整PTC NOT_TESTED | 旧版在限定shared FA有deny链出现live admission拒绝；适配后内层独立准备且不扩权 |
| X3：FA page root选只读根 | CODE_RISK，PTC可能先被A4拒绝，不能声称越权已复现 | 记录是否到达Worker、.dsh-ops/lock和cache；适配后不产生拒写副作用，不能只看业务状态 |
| X4：Linux WW batch与私有temp | F07函数级冲突已复现；Linux内核NOT_TESTED | 旧版误拒；新桥argv归属正确，临时文件在宿主可见、ref有效、deny未被bind覆盖 |
| X5：hook顺序/单行重载 | NOT_TESTED；需要适配原型 | cap与frame一致，保护缺席不裸写，依赖无环且卸载保留负边界 |
| X6：shared WW销毁会话清cache | 源码CODE_RISK；生命周期NOT_TESTED | 记录cache残留、告警及清理入口的有效准入，不以关闭日志当修复 |
| X7：适配后FA显式RO实写（V1） | NOT_TESTED；本轮只有未适配F01旧证据 | 真正受限argv、目标哈希不变、创建/删除无越权且失败如实上报 |

拟议首期原型缩为D1 Full-access全部Worker与D2 Phase A live。WW/RO固定文件的应用层信任需要维护者决策，内核路线需OPS私有区域声明；D3、F07 cache接缝、后台启动属OPS协作，Phase B早期宿主属DSH接口依赖。PTC、Auto Review、Linux、Windows均保留自己的验收边界，不因本轮函数测试通过宣布完整兼容。报告与ADR已修订，状态仍未接受。


## 15. ADR与计划联合复核R1–R4

本轮只做源码核对与合同修订，ADR及active plan继续Proposed、未启动。这里的R编号属于计划复核，不替代§12的早期R编号；具体执行规则以ADR D1.1a/D1.1c/D1.3为唯一真源。新增静态源码摘录与哈希（本地 `plan-contract-source-excerpts.txt`），没有新增动态通过结论，既有函数探针结果不变。

| 项 | 核对与拟议处置 | 验证边界 |
| --- | --- | --- |
| R1首期范围 | WW/RO明确选择维持现状并披露，新增FA失权早拒和ready guard不影响RO读。OPS native/src/lib.rs:29只在非RO时开启结果capture，result-storage.ts:136在RO不创建cache；reference写操作另拒RO | 静态PASS；新增策略尚未实施，WW/RO过渡及失权RO读回归NOT_TESTED；现有F07/profile拒绝继续存在 |
| R2准备重叠 | cache是canonical tmpdir下一个固定格式的叶目录；拒绝谓词限于deny包含tmpdir，或deny落在其直接cache族及后代。普通tmp兄弟根不触发。叶目录创建0700，lstat检查不是“必须精确0700”，而是拒非目录/符号链接、group/other权限及错误属主 | 源码PASS；拟议检查与V1/V2到达受限Worker的对照NOT_TESTED。包含cache子目录，不能只比较deny的basename；不可借检查忽略并发路径变化 |
| R3保护存活 | 已核tools@0.2.0-rc.2公开guard为pre-execute后、dispatch前的同步单调拒绝。拟由scope持有guard，fence发布scope实例/代次绑定的ready token；不再仅依赖OPS协作关闭普通dispatch入口 | API静态PASS；两个宿主的真实guard、调度窗口、单行卸载与重载NOT_TESTED。guard用preview拒绝，不能用准入前resolve缺frame误判全部shared调用 |
| R4 cap执行域 | scope现有capForTool为父ALS与本工具cap的OR，remember/permit读取capped()。拟新增withToolCap，scope监听器和fence均调用，包住admission到next/spawn | 现有源码PASS；拟议方法不存在、幂等/双顺序/重载验证NOT_TESTED |

A2适用范围补正：PTC的j-/r- page可打开.dsh-ops store，A4先拒绝仅限满足其条件的shared组合；legacy没有该frame检查，不能据此认定安全。Native result在projections/native/result.ts:30只接受ref://，不会进入该store路径。两种入口的实际副作用组合仍按CODE_RISK记录，未追加实写。

计划已同步：legacy失权代价限定为FA下全部受适配OPS执行调用（含读，纯发现/发布除外）；Windows后台Bash在macOS仅结构验证；P0必须分别准备0.2.0-rc.2和Auto Review的0.2.1-rc.2；Native Phase A可在P0后与执行原型并行，PTC端到端需先具备内层保护。本轮未执行这些任务，也未改变当前支持声明。

## 16. 适配后复验

原 §1–§14 的 CONFIRMED 历史结果完整保留；本节只记录修复后的对照证据，不覆写任何早期条目。

| 项 | 复验结果 | 证据 |
| --- | --- | --- |
| F01 deny 执行（RO/cap 拒绝 OPS 写） | PASS：两个宿主各 10/10 checks、13/13 spawn 携带 deny；真实 PTC 只读根写入返回 ACCESS_DENIED，目标前后 SHA256 相同 | Host A v3（本地 `ops-adaptation-live-v3-results.json`）、Host B v3（本地 `ops-adaptation-live-v3-hostb-results.json`）、A 日志（本地 `v3-host-a.log`）、B 日志（本地 `v3-host-b.log`） |
| F05 inspect 顶层无 path | PASS：行派生 canonical path 恢复 ancestor 链（真 AgentLoop 下一模型请求含所需 sentinel） | `dsh-ops-audit-evidence/ops-adaptation-loop-host-a.json` / `ops-adaptation-loop-host-b.json`，`loop-host-*.log` |
| Native partial read_files 2 成功 1 失败 | PASS：两成功目录注入、失败目录 sentinel 缺席 | 同上 `native-partial-multiple-targets-next-model-request` |
| 真实 PTC（run_code 子 dispatch） | PASS：两个目录链均到达下一模型请求；所有 spawn 带 deny | 同上 `real-ptc-subdispatch-next-model-request`；旧“缺包 PTC composition gap”不是真实根因，P0 toolsGuard 夹具错误与 v2 未 presentAs 已由 v3 纠正 |
| Review 合同 | PASS：live 证据合并、缺证/动态/冲突/PTC 身份/未结算/恢复全部技术失败；pending 不消耗 delivery | Host B `tests/auto-review/context.spec.ts` + `ops-context.spec.ts` 两文件共 36/36，日志 `p4-hostb-rc2-review-tests.log`、`final-hostb-review-tests.log` |
| Host B OPS 构建 | CONFIRMED 构建失败：rc2 下 OPS 源码 typecheck 不通过（既披露）；运行的为 Host A 同 commit 同 hash 本地构建 lib/worker 原样 stage（非 npm 发布物），不能声称 Host B build 通过 | — |
| 平台/外围（Windows ACL、bwrap/Landlock 变体、smoke/pack、kernel 外部 probe） | NOT_TESTED；AgentLoop 证据中 spawn 的真实 Seatbelt confined 与未运行的 kernel 外部 probe 不是同一件事 | — |


## 17. P5 本仓保守兜底（2026-11-05）

按用户本次直接授权，不修改 OPS、不恢复依赖 OPS 新接缝的合法写入；WW/RO 有禁写附加根或 tool cap 时，在 OPS 准备前拒绝整个执行调用（读/page 也可能被拒），所有模式失权时拒绝执行。Full-access 保留现有 deny 内核策略。scope 增加独立 spawn 闸门，没有保护域同步交接或当前 admission 精确 profile 的启动被拒，单独卸载 fence 也不能裸启动清理 Worker。代价是缓存清理及部分第三方调度外进程可能被拒。

Phase B 继续关闭：当前 DSH Session 文档明文禁止外部插件调用 `appendPluginRecord`，没有合法持久记录接口可接入。恢复会话后，缺少逐项成功证据的 OPS 历史不会被当成成功 touch，Review 仍会技术失败。D3/F07、合法后台恢复与其他平台仍是后续事项。

本次逐文件副作用、Native/PTC 和卸载验证通过本仓 `scripts/verify-ops-protection.mjs` 复跑，原始输出留在隔离宿主内，不提交证据目录。具体版本、通过数及仓库门禁只登记在[进度总账](../plans/active/2026-09-12-multi-root-workspace.md#进度总账)。
