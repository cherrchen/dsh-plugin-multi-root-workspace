# 外部安全报告核实：`@dsh-electron/dsh-plugin-multi-root-workspace`（邮件审计 v0.1.8）

核实日期：2026-11-05
核实人：Devin（仓库维护者委托）
核实方式：对照当前源码与上游 `0.2.2-rc.1` 依赖树的静态核实 + 仓库既有测试/文档证据。**未执行端到端利用，未安装插件 tarball，未接触真实 `$DSH_HOME` 凭据或日用配置。**

## 对象与基线

- 邮件报告：`安全报告：@dsh-electron/dsh-plugin-multi-root-workspace@0.1.8 发现严重问题`（F.B. / FishBoneEK@outlook.com，2026-10-20，Gmail 垃圾邮件文件夹）
- 附件：`SECURITY-AUDIT.md`、`A-confinement.md`、`D-bypass.md`（审计基线：插件 `v0.1.8` / commit `15c1d263…`，宿主 DSH `0.2.1-rc.2`，Linux）
- 本仓库核实基线：**`v0.1.14`（commit `306d65a`）**，开发宿主 `@deepseek-ai/*@0.2.2-rc.1`，cordis `4.1.0`，macOS arm64
- 邮件与附件原件：`/tmp/dsh-mail-audit-{SECURITY-AUDIT,A-confinement,D-bypass}.md`

> 注意：邮件审计的是 **v0.1.8**，其后仓库已发布 v0.1.9–v0.1.14 共 6 个版本。本文逐条区分「当前仍存在」「v0.1.9+ 已修复」「设计取舍」「未能复核」。v0.1.8 上的历史结论不自动等于当前结论。

## 结论速览

| 编号 | 邮件评级 | 当前结论 | 一句话 |
| --- | --- | --- | --- |
| BYP-01 面板 `add`/`setAccess` 无审批 + cookie 伪造 | Critical | **成立，仍存在**，且发现第二条可达路径 | 根管理 RPC 与 `/workspace-folders` 命令都直达 `registry.add`，均无宿主审批；cookie 签名密钥 agent 可读 |
| MRW-01 主根 symlink swap 清空 Full-access deny | High | **成立，仍存在** | scope 每次按 `canonicalPath(workspaceRoot)` 现取 key，主根被换名后 deny 集整体落空 |
| BYP-02 revive 把重定向根重新授权到新目标 | High | **成立，仍存在** | `registry.add` revive 分支记录**当前** canonical target；面板「重新登记」是单击无确认 |
| B-01/MRW-08 `registryAuthority` 默认 available fail-open | High | **部分成立**（机制存在，场景收窄） | registry 行不挂载而 fs/sandbox/scope 仍挂载时，Full-access 走 ambient 快速路径而非 unavailable 收敛；但需「registry 行缺席 + 存储内有 deny」同时成立 |
| MRW-03/BYP-03 `$DSH_HOME` 非登记边界、deny 仅 Full-access | Medium-High | **成立，仍存在** | workspace-write 下可登记 `$DSH_HOME` 祖先或其本身，store/profiles/凭据可写 |
| BYP-06/MRW-04 Full-access 投毒 store/lease 产生双 authority | Medium/Low | **成立，仍存在** | 无 deny 时不保护 `$DSH_HOME`；lease inode 仅获取时校验一次 |
| MRW-02/BYP-05 POSIX hardlink 绕过 read-only | Medium | **未定论（需原生确认）** | 强制层全部是路径/挂载语义；Windows 侧已有 nlink 预检，POSIX 侧从未处理 |
| MRW-06/BYP-04 检查-写入 TOCTOU | Medium/Low | **成立（继承上游）** | `checkedTarget` 与原子写之间仍有窗口，上游同样接受 |
| MRW-05 Landlock DoS / bwrap 回退标 `enforcement:"full"` | Low | **成立（fail-closed 可用性问题）** | Landlock 表达不了子树减法→拒 spawn；Full-access 改走 bwrap 是有意设计，但标注值得商榷 |
| BYP-07 PTY 仅靠单个 env key 区分 agent/用户终端 | Medium | **成立（设计级）** | `DSH_PTY_SESSION_ID` 判别 + 源码子串探针，未变 |
| BYP-08 `git`/`rg`/LSP/MCP 等不经 `ctx.sandbox` 的 spawn 不受限 | Low-Medium | **成立（上游行为被放大）** | 插件只包装 `ctx.sandbox` 消费者 |
| BYP-09 DoS / BYP-10 控制字符路径 | Low/Info | **成立** | 拒绝根落在 `/tmp` 可致 Landlock 全灭；root path 不拒控制字符 |
| 供应链：koffi allowBuilds / attestations / sourcemap | High/Medium | **部分成立**（见专节） | `allowBuilds` 属仓库自身 pnpm-workspace.yaml、不进 npm tarball；`prepare` 脚本存在但仅影响本仓库开发 |

**总评**：邮件的核心指控方向正确——插件确实新增了一条「不经人工审批即可授予文件系统根」的授权面，且 cookie 伪造链在上游 `0.2.2-rc.1` 上逐环节复核成立。但「Critical」评级需要打折：利用前提是 prompt 注入 + agent 可读 `$DSH_HOME/.credentials.yaml` + 无 Origin 的 loopback cookie 被接受，这三点均属**上游 DSH 的既定信任模型**（同一 uid、读不设防、bearer secret 落盘）；插件的问题在于它把「授予写根」这种上游不存在的高危操作放进了这个模型保护下的通道，且自身 UI 也无确认。建议按 High~Critical 修复，但定级时应注明前提链。

---

## 1. BYP-01：面板/命令 RPC 自行授权根目录 —— 成立，仍存在

### 代码路径（当前 `v0.1.14`）

- 面板通道：`connection.rpc.handle(PANEL_CHANNEL, …)` 注册的 handler 由上游 `rpcFetchHandler` 以 `handler(endpoint, payload, signal, peer)` 调用——**`peer` 是第 4 个实参**；插件的 `dispatchPanelRequest(ctx, endpoint, payload, signal)` 只声明 3 参，`peer` 被静默丢弃（`src/command.ts:624`、`src/command.ts:220-221`；上游 `dsh-client-connection/lib/index.js:910`）。`case 'add'`（`command.ts:653`）/`'setAccess'`（`:672`）/`'setSkillsEnabled'`/`'setAliasId'`/`'remove'`/`'alias'`/`'move'` 均直达 `registry.*`，**全程无 `ctx.approval`、无一次性 nonce、无 peer 类型检查**。
- 命令通道：`/workspace-folders add <path> [--read-write]` 经 `runCommand` 直达同一个 `registry.add`（`command.ts:244-254`）。命令注册为 `source: { kind: "user" }`（`dsh-commands`），模型不可直接调用；但上游 `dsh-commands` 的 Typert Remote `commands/execute` 以同一 cookie 认证暴露给浏览器（`dsh-commands/lib/typert.host.js`），伪造 cookie 者可 `commands.execute(sessionId, "/workspace-folders add /x --read-write")`。`CommandInvocation` 只携带 `agent`/`rawInput`/`attachments`/`signal`，**不含 peer/principal**——该路径的调用与人工 composer 输入在命令层不可区分。**只给面板通道加审批不够：闸门必须下沉到 `registry.add`/`setAccess`，或同时覆盖面板 RPC 与 `commands/execute`/`runCommand` 两个入口。**
- `ctx.approval` 服务存在（`@deepseek-ai/dsh-user-approval`，本仓库 Auto Review 已在用），插件只是没有把根变更挂到它上面。
- 上游先例：`createSharedFetchHandler` 对精确路由强制 `peer.principal.kind === "owner"` 否则 403（`dsh-client-connection/lib/index.js:830`）。插件若接住 `peer` 做 owner 检查可挡非 owner API peer，但**挡不住本报告的攻击**：伪造的 v1 cookie 在 `admit()` 中同样落到 `browserPeer`（`principal.kind === "owner"`，`index.js:714,746`）。peer 检查只是纵深防御，`ctx.approval` 才是正解。

### Cookie 伪造链复核（对照 `0.2.2-rc.1`）

逐环节在当前依赖树中复核，**全部成立**：

1. agent shell 环境含 `DSH_HOME`、`DSH_SESSION_ID`（`dsh-shell-env`）；读不设防是上游既定模型。
2. 签名密钥落盘 `$DSH_HOME/.credentials.yaml`（`dsh-credentials-local`），0600、属主即 agent 用户 → agent 可读。
3. cookie 格式 `v1.<b64url(payload)>.<b64url(HMAC-SHA256(secret, body))>`，authority 为 loopback Host；`isTrustedApiRequest` 对**无 Origin** 的 loopback Host 请求放行。
4. 受限 bwrap profile **无 `--unshare-net`**（`dsh-sandbox-local/lib/index.js` 只有 `--unshare-pid`）→ agent 可连 `127.0.0.1:<web 端口>`。
5. 校验只拒非绝对路径/不存在/与主根重叠/重复/嵌套；`$DSH_HOME`、`~/.ssh` 这类与主根不相交的目录可直接登记为 `read-write`，随后 `ctx.fs`/沙箱立即放行写入。

邮件自报「认证原语已验证、端到端未执行」与本文静态复核一致：链路每一环都能在代码里坐实，唯独没有人真的发过那一个 POST。

### 定级与修复建议

- **定级**：上游信任模型（同 uid 可读凭据 + bearer cookie）是既定前提，插件把「授予写根」放进该模型是**插件侧的授权缺失**，而非上游漏洞。建议修为 **High~Critical**，对外沟通时写明前提链。
- **修复**：
  1. `registry.add` 与任何**扩大** `setAccess`（inherit/read-only → read-write，或 read-only → inherit 于 Full-access）必须走 `ctx.approval` 真实人工审批——注意审批点要在 registry 层或同时覆盖面板 RPC 与 `commands/execute` 两个入口；
  2. 面板 `add` 拒绝 cookie-only principal，或要求一次性 nonce/宿主侧 picker 回执绑定；
  3. 对登记结果写审计日志；
  4. 短期缓解：在 `validateRootCandidate` 拒绝与 `$DSH_HOME` 相交的候选（见 §5），可先堵住最危险的落点。

## 2. MRW-01：主根换名清空 Full-access deny —— 成立，仍存在

- `MultiRootScopeService.project()` 每次用 `canonicalPath(policy.workspaceRoot)` 现取 primary key（`src/scope.ts:548`），再以 `rootsByPrimary.get(primaryRoot)` 取该主根的记录（`:549`）；registry 记录按**注册时** canonical primary 存储。换名后新 key 查无记录 → `registered=[]` → `deniedRoots=[]`（`:556-563`），`protectedHome` 因 `deniedRoots.length > 0 || authority === 'unavailable'` 不成立而跳过（`:570-577`）。
- `danger-full-access` + 至少一个 `read-only` 根时，受限 bwrap/Seatbelt profile 只 pin **denied 根的祖先**，不 pin session cwd 自身 → agent 在受限 shell 里 `mv "$PWD" "$PWD.real" && ln -s "$PWD.real" "$PWD"` 即可让 `canonicalPath(workspaceRoot)` 解析到 `.real`，全部查找落空：`deniedRoots=[]`、`writableRoots` 退回、`protectedHome` 消失，fs 走 Full-access 快速路径、process-fence 不加前缀。
- **v0.1.12 的 shared-registry admission 不缓解此问题**：admission/快照用的是同一份漂移后的 key，自洽地 miss。
- 仅影响 `danger-full-access`；`workspace-write` 仍按 containment 允许清单收敛（额外根丢失属可用性问题而非越权）。

**修复**：primary 解析结果与「注册时记录的 canonical primary」不一致时，应视为 authority unknown 并复用现有 unavailable clamp（fs 降级为仅主根可写、shell/PTY 拒绝扩展 profile）；或在受限 profile 中把 session cwd 也 self-bind 为 mountpoint，使其不可被 rename。

## 3. BYP-02：revive 把重定向根重新授权到新目标 —— 成立，仍存在

- `registry.add` 的 revive 判定（`src/registry.ts:668-673`）：候选 `preliminary = canonicalRoot(input.path)`（**当前**解析结果）与既有记录比对时，同时接受 `status.path === preliminary` **或** `canonicalRoot(status.path) === preliminary`——即「记录的旧拼写现在解析到哪儿」也算同一登记。
- 命中后走 revive 分支（`registry.ts:716-727`）：`path: canonical`（`validateRootCandidate` 对输入**当前** realpath 的结果）+ `grantFields(access, canonical)`——把**新目标**按旧 access 写成 `recordedPath` 授权。注释自称「re-registering … is the operator confirming it」，但操作者确认的是**名字**，不是解析后的新目录——与铁律「re-resolving is not re-authorizing」正面冲突。
- 面板「重新登记」`reRegister()` 就是 `mutate('add', { path: root.path })` 单击发起（`WorkspaceFoldersAction.tsx:493-497`），无确认框、不展示新旧 canonical 对照。重定向行只显示 `state.redirected` 徽标「登记目录已被替换（现在指向别处），暂不授予」（`locales.ts:84,181`）——**不告诉操作者它现在指向谁**。
- 现实链条：操作者曾把 `/tmp/scratch/proj` 登记为额外根（临时目录是常见用法）；agent 在 workspace-write 下（`/tmp` 可写）把它 rename 并换成指向 `$DSH_HOME` 的 symlink；操作者下次打开面板看到黄条警告，点刷新图标「修复」→ `$DSH_HOME` 按原 access 被授权。混淆代理（confused deputy）成立。

**修复**：revive 必须要求 `canonicalPath(path) === recordedPath`；重定向记录只能走 remove + 显式确认的新 add（面板确认框展示 old vs new canonical target）。这是三个 High 中改动最小、收益最直接的一个。

## 4. `registryAuthority` 默认 `available`（B-01/MRW-08）—— 部分成立

- `MultiRootScopeService.registryAuthority` 字段默认 `'available'`（`src/scope.ts:349`）。
- registry 服务构造函数在 `openDomain()` **之前**同步调 `setRegistryAuthority(false)`（`src/registry.ts:385`），打开存储并发布全部根之后才置 `true`（`:1529`；follower 侧由 `applySnapshot` 在同一 commit 内置 `snapshot.available`，`:1216`）——**只要 registry 行完成构造，fail-closed 次序就是对的**。
- 缺口在「registry 行根本不挂载」：其 `inject = ['multiRootCompat', 'multiRootProviders', 'storageDomain', 'multiRootScope']`（`registry.ts:301`），任一缺失/抛错（不支持的 DSH 版本、provider 冲突、宿主未提供 `storageDomain`）都会让整行缺席；而 `fs`/`sandbox` 只 inject `['sandboxPolicy', 'multiRootScope']`（`fs.ts:64`、`sandbox.ts:62`），`fs.withOperation` 对缺席的 registry 走 `ctx.get` 软降级（`fs.ts:150-153`）——**providers 按 ADR-0009 设计就是要能在无 registry 时工作**。
- 后果链：scope 停在默认 `available` + 空 `rootsByPrimary` → `project()` 产出 `deniedRoots=[]`（`scope.ts:556-563`）→ `checkedTarget` 的 unavailable 收敛分支不触发（`fs.ts:212-215`）→ `danger-full-access` 走 ambient 快速路径。此时磁盘上的持久 store 里若有 `read-only` 根，本进程从未加载，deny 被静默丢弃——正确行为应是按 `unavailable` 收敛到仅主根可写。
- **收窄说明**：需要「registry 行缺席」与「Full-access 模式」同时成立；`workspace-write`/`read-only` 模式不受影响（本来就收敛）。属真实 fail-open 默认值，但触发面窄，且「providers 无 registry 也能跑」是刻意设计——修法不是拆设计，而是把 scope 默认值翻成 `unavailable`、让 registry 独占置 `available`（`:1529` 已经这么做了，改动很小）。

## 5. `$DSH_HOME` 边界 —— MRW-03/BYP-03/BYP-06 成立

- `protectedHome` 只在 `danger-full-access` 且存在 deny 集（或 authority 不可用）时加入（`src/scope.ts` 末段）；`workspace-write` 下**没有** `$DSH_HOME` deny。
- `validateRootCandidate`（`src/roots.ts`）不查 `dshHome`：操作者（或经 BYP-01/02 的 agent）可登记 `$DSH_HOME` 的祖先目录（如用户家目录本身）或 `$DSH_HOME` 本身 → store、lease、`profiles/`、`.credentials.yaml` 全部可写 → 下次启动持久化代码执行/扩权。
- 无 deny 的纯 `danger-full-access` 会话同样可写 store/lease（BYP-06）：注入一条 `{path: 任意目录, recordedPath: 同}` 的记录，下个 `workspace-write` 会话即被分类接受为授权——一次 Full-access 剧情永久扩权。
- lease 的 inode 校验只在 `acquire` 时做一次（`src/registry-lease.ts`）；unlink/recreate 可产生第二个 authority（MRW-04）。

**修复**：`validateRootCandidate` 在所有模式下拒绝「等于/包含/被 `$DSH_HOME` 包含」的候选（可配置豁免）；`workspace-write` 下对落入授权集的 `$DSH_HOME` 施加廉价 deny；lease 持有方在每次 publish/mutation 前复核 inode。

## 6. 其余条目核实

- **MRW-02/BYP-05 hardlink（未定论）**：fs deny、`isPathUnder`、bwrap `--ro-bind`、Seatbelt deny 全部是路径/挂载语义；同 uid `linkat` 到可写目录理论上可把 read-only 根内 inode 引到授权路径下写。邮件自己也标注「reasoned、需原生确认」，其 bwrap 探针返回 `EXDEV` 与推断不一致。2026-10-16 hardlink 计划（`docs/plans/active/`）只覆盖 **Windows** nlink 预检，POSIX 侧从未处理。**维持「read-only 根是路径策略而非数据完整性边界」的文档表述即可，不必当作已证实漏洞，也不应当作已排除。**
- **MRW-06/BYP-04 TOCTOU**：`checkedTarget` resolve 后到上游原子写之间仍有窗口（上游 `dsh-fs-local` 按路径 rename，无 `openat2`）。属继承上游的已知残余，建议文档明示。
- **MRW-05**：Landlock `denyProfileArgs` 遇到「denied ∩ `--rw` grant」重叠直接抛 → read-only 根落在 `/tmp` 时所有 workspace-write shell 调用 fail-closed（可用性 DoS，方向安全）。Full-access 的 Landlock→bwrap 替换是**有意设计**（`src/sandbox.ts` 注释与 ADR 一致），但上报 `enforcement:"full"` 确实掩盖了「实际由 bwrap 执行」这一事实，值得在 diagnostics 里如实标注。
- **BYP-07**：agent/user PTY 仍靠单个 `DSH_PTY_SESSION_ID` env key 区分，boot gate 仍是对产物 JS 的子串扫描；`ctx.terminals` 仍刻意不包装。属设计级残余。
- **BYP-08**：`git`/`rg`/LSP/MCP spawn 不经 `ctx.sandbox`，插件只包装 `ctx.sandbox` 消费者——上游行为被「read-only 根」承诺放大，文档应限定「受限进程」范围。
- **BYP-09/10**：属实但低危。拒绝根在 `/tmp` 的 Landlock DoS、root path 不拒控制字符（`normalizeAlias` 拒、`validateRootCandidate` 不拒）。

## 7. 供应链条目核实

- `allowBuilds: { koffi: true }` 在**本仓库** `pnpm-workspace.yaml`，**不进 npm tarball**——只影响本仓库开发/CI，不影响插件安装者。邮件把它列为面向安装者的 High 风险，**不成立**。
- `package.json` 有 `prepare: pnpm run bundle`——邮件称「无生命周期脚本」略有出入；但 `prepare` 对 registry tarball 安装不执行，实际风险为零。
- `koffi` 在 `dependencies` 且 `loadHostKoffi()` 优先锚定宿主副本——这是 v0.1.14 刻意的 Issue #30 修复（避免 darwin-arm64 双 native 镜像 SIGBUS），方向正确。
- attestation/provenance 无法离线复核，维持「未证实」即可。

## 8. 建议修复优先级

1. **根变更审批**（BYP-01）：`add` 与扩大性 `setAccess` 走 `ctx.approval`，覆盖面板 RPC 与 `commands/execute` 两个入口；拒绝 cookie-only principal 做根变更。
2. **revive 不重新授权**（BYP-02）：`canonicalPath(path) === recordedPath` 才允许就地复活；重定向根只走 remove + 显式新 add。
3. **`$DSH_HOME` 全模式登记边界**（BYP-03/06）：候选校验拒绝与 home 相交；workspace-write 下对落入授权集的 home 施加 deny。
4. **primary key 漂移 = authority unknown**（MRW-01）：解析结果与注册 canonical 不符时按 unavailable clamp。
5. **authority 默认值**（B-01）：registry 行缺席而 scope/provider 挂载的组合下，`registryAuthority` 不应停留在 `available`+空表。
6. 文档：把「read-only 根是路径策略、非数据完整性边界（hardlink/TOCTOU/未包装 spawn）」写进 README/guide，避免过度承诺。

## 9. 审计限制

- 全部结论为**静态代码核实**（当前 `src/` + `node_modules` 内 `0.2.2-rc.1` 上游产物）；未做端到端利用、未发任何真实 RPC。
- Linux/bwrap/Landlock 行为、Windows 原生路径、LSP/MCP runtime 未在本机（macOS arm64）复核；邮件标注「reasoned」的条目本文同样标注。
- 邮件基线 v0.1.8 与本基线 v0.1.14 相距 6 个版本；凡「当前仍存在」均给出当前代码位置，「已修复」类条目在正文注明版本。
