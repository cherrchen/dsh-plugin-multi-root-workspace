# ADR-0012: Session 原始项目与当前执行目录分离

## Status

Accepted

## Date

2026-10-10

## Context

DSH `0.2.1-alpha.2` 新增 `workingDirectory` 和实验性 Worktree 服务。原生文件工具、bash、PTY 和 LSP 开始使用可变执行目录，而 `sandboxPolicy.workspaceRoot`、Workspace Files scope 和 Session header 仍以原始项目为边界。动态 cwd 解决相对路径解析，不能替代多根授权。上游差异与源码定位见[接口审查](../reference/dsh-0.2.1-migration.md)。本决策扩展 ADR-0001、ADR-0008、ADR-0010 和 ADR-0011 的 cwd 假设，不更换授权模型。

## Decision

### 身份、解析与授权

| 概念 | 当前实现的唯一来源 | 用途 |
|---|---|---|
| Session 原始项目（sessionOriginRoot） | `session.header.cwd` → `sandboxPolicy.resolve({ session }).workspaceRoot` | canonical Registry 主键、Primary root、面板 authority |
| 当前执行目录（effectiveCwd） | 上游 `workingDirectory.get/ensure(session/agent)`；旧宿主使用 header cwd | 新操作的相对路径和默认 cwd；不是授权来源 |
| Additional roots | Registry 验证后经 `multiRootScope.setAdditionalRoots()` 发布 | 显式授权的附加目录 |
| authorizedRootSet | `writableRoots(policy)` + 当次 scope 中可用的 Additional roots | workspace-write 修改范围，包含上游平台临时区；read-only 不增加写授权 |

不新增 cwd 持久化表，也不包装 `workingDirectory.set()`。`ensure()`、持久化 `working-directory/change`、恢复缺失 cwd 和 resume projection 均归上游。切入附加根、普通子目录或未登记目录不改变主根、Registry key 或根集合。上游可以把 cwd 设置到未授权目录，因为 stat/read 并非写授权；之后的写入仍被原始 policy + scope 拒绝。文件读取仍继承上游各模式的公开读取边界，插件没有引入额外的读取 ACL。

### LSP

新版工具以 effective cwd 作为 query 的 `workspaceRoot`，该请求没有 Session 字段。`tools/execute` 的公开 around-dispatch waterfall 在 AsyncLocalStorage 中携带调用 Session；scope 查询用 header 原始项目（header 缺失时使用 sandboxPolicy 的部署 fallback；两者均缺失则拒绝），相对 filePath 用传入的执行目录，canonical target 决定所属根。不能根据 cwd 搜索任意 Session 或注册表：两个会话可以共享 cwd 而拥有不同主根。

同一根的查询继续交给上游 stdio provider 池化；切换 cwd 不创建另一份项目身份。未授权路径交回上游时使用原始主根与绝对目标，避免把相对路径误解成主根内同名文件。非工具直接 query 保留原公共接口语义。旧宿主没有 around-dispatch seam 时此监听不产生行为，其原生工具本来就传 header cwd。

### 指令

成功的 `tool/call` / `tool/result` 配对仍是唯一 touch 成功判据。相对路径在 call 发生时捕获上游 effective cwd；原生工具执行中的 `fs/observed` 提供真实 canonical target 时优先采用它，覆盖 `ensure()` 恢复和并发 cwd 变化。执行上下文与状态均按 Session 隔离，不以当前全局 cwd 推导。

发现继续钉在附加根，global display path 不作为项目相对路径接受；即使 `$DSH_HOME` 或共享 agents home 位于已登记根内，也不由插件重复加载全局候选。解析目标与读后路径身份再校验，异步 I/O 后再次检查 scope：已撤销或 redirect 的根不投递新规则，旧规则明确撤销。

插件在 native pre-step 完成后检查这一批消息的 `agent-instructions` baseline metadata；同一绝对文件、同一完整 SHA-1 content digest 已由 native 消息表示时，不再添加一份插件副本，但仍登记自己的根范围，以便后续显式撤销。没有可验证 metadata 或文本不同就正常投递，绝不从提示词 prose 推断 authority。

投递状态区分插件投递与 native 代投递；native 的 `remove` 按代投递时记录的 display scope 使对应 digest 失效，baseline 替换则使全部 native 代投递 digest 失效（新项目可能复用同名 scope 而没有 remove）。失效保留绝对 scope 和已考察 nested 目录，即使补发因预算或构造失败延后也会重试；本批消息仍表示同一绝对文件与完整内容时继续去重，否则下一步由插件补发。native 撤回不使插件自身投递的 digest 失效。插件自己的 scope/digest 不因 cwd 变化清空；上游主动重新呈现其 baseline 属于上游协调行为，历史文本不被修改。

### 面板与 Workspace Files

面板仍只提交 live `sessionId`，host 的 Primary root 始终来自 header。`RootsView.effectiveCwd` 是可选显示字段，在根列表之外展示「当前执行目录」，不能用于文件树 root-entry 或任何 Registry mutation。Session catalog 可订阅时切换会清空旧 view、菜单与编辑状态并重新 list；旧请求回包须同时匹配 request epoch 和 Session id。文件树已有相同 Session identity 检查。旧客户端可忽略新字段。

原生 Workspace Files 的 session scope 仍是 header cwd，其协议相对路径保持项目相对；附加根树继续用明确 root-entry，未因动态 cwd 改写协议含义。

### Worktree 与进程快照

不实现或替换 Worktree 服务。checkout 内 `.agents/worktrees/` 是已授权根的后代，普通 `.git` 文件指向共享 gitdir（不是目录 symlink）；只有 gitdir 也在既有可写集合中时创建/修改合法。在 Additional root 中创建使用 Session 原始 policy 和附加根 grant，切回后所有注册仍属于原始项目。

外部 gitdir、逃逸 symlink、未登记 repository 或未授权的自定义 pool 不能通过扩大权限解决。上游失败/取消可能留下 branch 或 checkout，插件不登记、不自动清理它们。删除当前 checkout 后上游 `ensure()` 恢复 header origin；显式登记的附加目录消失仍由 Registry 的 missing/redirected 机制处理。

已启动进程/PTY 保留自己的 cwd 与内核授权快照。Registry 撤销影响后续 fs 调用和 confine，不承诺回收已运行进程的能力；要回收旧快照，应结束旧进程再启动。新服务没有同步修改旧 shell 的 `cd`。

## Alternatives Considered

- 用 effective cwd 替换 policy root / Registry key：会隐式授权并错配持久化，拒绝。
- 自建 cwd 状态或替换 bash / PTY / Worktree 服务：重复上游持久化与生命周期，拒绝。
- 全局按 cwd 反查 Session：Session 共用目录时串扰，拒绝。
- 改写上游指令 prose 或把文件内容抬升到 systemPrompt：既不可靠，也破坏上下文层级，拒绝。

## Consequences

原 provider 架构、lease、精确门禁、方言观测克隆和未知方言 fail-closed 保留。新增适配均集中在 `src/compat/`；carrier barrel 不静态加载可选新服务。

安全检查仍是路径身份与上游文件操作/内核 runner 的组合，不能把多次 realpath 声称为跨任意敌对 rename 的原子事务。TOCTOU 边界与已启动进程快照是继承的限制，不能以扩大授权或 full-access fallback 规避。完整执行证据和未覆盖平台只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md)。

## Related Documents

- [架构](../architecture/multi-root-workspace.md)
- [ADR-0007：Registry authority lease](./ADR-0007-registry-authority-lease.md)
- [ADR-0009：精确版本门禁](./ADR-0009-dsh-compat-contract.md)
- [ADR-0010：附加根指令](./ADR-0010-additional-root-instruction-scope.md)
- [ADR-0011：多根消费方](./ADR-0011-multi-root-workspace-consumers.md)
