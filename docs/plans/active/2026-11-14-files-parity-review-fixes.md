# 附加根 Files code review 修复（4 项）

> 状态：进行中（2026-11-14）。本文件既是修复计划也是执行账本：每阶段结束把命令与结果写入 §7。
>
> 分支：`feat/addtional-file-tree-1114`（PR [#56](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/56)，Draft）。
> 关联：[ADR-0041](../../decisions/ADR-0041-additional-root-workspace-search.md)、[ADR-0042](../../decisions/ADR-0042-additional-root-row-context-menus.md)、
> [已完成计划](../completed/2026-11-14-additional-root-files-parity.md)、`src/client/files-tree/FORK.md`。

## Goal

修复 PR #56 的 code review 指出的 4 个行为缺陷，使附加根 Files 的搜索交互与其持久化/清理语义与设计一致，
并在同一 PR 分支上以可回滚的分批提交交付、CI 全绿。

## Background（逐条核验）

四条 review 结论**均成立**；下表记录定位与根因（行号为修复前）：

| # | Review 结论 | 代码位置 | 根因判定 |
| --- | --- | --- | --- |
| R1 | 设置浮层用其 toggle 关闭时丢弃排除规则草稿 | `src/client/files-tree/pane.tsx` L632（修复前） | 成立。`onSettings` 在浮层打开时只执行 `setSettingsDraft(undefined)`，而 `SearchBar` 在 `settingsOpen` 时对 `mousedown` 调用 `preventDefault`（L424），blur 不会先触发提交，`closeSettings` 从未被调用；后续搜索仍用旧 excludedPaths。 |
| R2 | 打开搜索结果再返回后，结果树回到全展开并滚到顶部 | `pane.tsx` L557–585；`search-state.ts` `searched` L175–181 | 成立。effect 不比较"该 pane root 是否已有同一请求的已结算答案"，每次挂载都重跑；`searched` 无条件把 `expanded` 重置为结果树的默认展开、`scrollTop` 置 0，覆盖了 remount 恢复。 |
| R3 | 搜索端点的 workspace-file 失败码被归一成 `panel/internal` | `src/command.ts` L836–863 dispatch catch；`src/files-search.ts` L74 原样冒泡 | 成立。catch 只识别 `RootValidationError` / `AuthorityRpcError` / `WorktreeError`；搜索包装会以 `workspace-file/outside-workspace`（`src/workspace-files.ts` L335–337）等 `RemoteError` 拒绝，上游 search 自身也用同一错误词汇（not-found / not-directory / outside-workspace / search-failed），最终落入通用分支。 |
| R4 | 关闭的 tab 永久保留搜索记录与整棵结果树 | `src/client/files-tree/adapter.tsx` L368（store 创建）、L421–432（owner 死亡清理） | 成立。`searchStore` 在 `createFilesTreeSeats`（apply 期一次）创建，被所有 session 的 inject product 共享；owner 死亡的 `dropDeadOwners` 只清 takeover 与 savedTrees，`SearchPaneStore.forget` 没有生产调用方。 |

## Scope

- R1：设置浮层 toggle 关闭时提交草稿（与 blur/Esc 路径一致）。
- R2：为搜索记录引入"请求身份"，同身份的已结算答案在 body 重挂载时复用，不重跑、不重置展开/滚动。
- R3：搜索端点边界保留上游 `workspace-file/*` 失败码，未知异常仍归一。
- R4：搜索记录改为 session 所有权；tab 所有者死亡时清理该 tab 的全部记录；body-only unmount 保留。

## Non-goals

- 不改搜索 UI 布局、不改偏好存储格式/键、不改端点请求字段、不改 Registry/授权语义。
- 不为搜索新增快捷键或原生导航器入口（既有边界不变，见 ADR-0041 §D4）。
- 不动 17 个本机沙箱不可复现的 authority/lease 测试（基线同因失败，CI 拥有信号）。

## Design

### D1 设置浮层的关闭语义

`SearchBar` 的 `settingsOpen` 时 `mousedown preventDefault` 保留（它保证点击 toggle 不先触发 blur 而闪关浮层）；
差异由回调查补：浮层已打开时再点 toggle 走 `closeSettings(settings, true)`，即与 Esc/blur 相同的"保存草稿 + 归还焦点"路径。
浮层内部按钮（关闭/恢复默认）与 blur 行为不变。

### D2 请求身份与重挂载复用

新增 `searchRequestKey({ rootId, query, excludedPaths, includeHidden, respectGitignore, attempt })`（`search-state.ts` 导出，纯函数、数组按序拼接），
它是"同一次请求"的唯一身份。`SearchPaneState` 增加 `settledKey`（最近一次结算对应的请求身份）：

- effect 的跳过条件：`state.settledKey === requestKey && result?.kind === 'found'` → 不调用 run、不写 store，展开/滚动/计数原样保留；
- `searched(key, result, settledKey)` 写入结果时记录身份；失败结果也记录身份，但**不**参与跳过（remount 仍会重试，符合"失败无位置可保"）；
- `setQuery`（查询变化）与 `retry`（attempt+1）清空 `settledKey`；筛选（excludedPaths/showHidden/respectGitignore）变化时 requestKey 变化，自然重跑并按原语义重置展开与滚动。

不引入"刷新时保留旧展开"的额外分支：只有"同请求重挂载"复用，其余仍是一次新的结算。

### D3 workspace-file 失败码透传

`command.ts` 的 catch 在已知错误类之后、`panel/internal` 之前增加结构化识别：
对象具有字符串 `code` 且属于上游 `workspace-file/*` 集合（not-found、not-directory、outside-workspace、search-failed、not-text、too-large、not-regular-file、watch-unsupported），
且 `message` 为字符串；则返回 `{ ok: false, error: { code, message, details } }`（details 原样透传对象，否则 `{}`）。
不按类名/版本判断；不在集合内的任意 `code`（含伪造的未知码）仍归一 `panel/internal`。

### D4 搜索记录的 session 所有权与 tab 清理

- `searchStore` 从 `createFilesTreeSeats` 顶层移到 `inject`（每个 session 的 inject product 一个实例）；
  `hooks.searchState` 与 seat 的 `store` 都来自该实例，跨会话不再共享，session 结束随 product 回收。
- `SearchPaneStore` 增加 `forgetTab(tabId)`：删除全部以 ``${tabId}\u0000`` 开头的键（一个 tab 可浏览多个根）。
- `dropDeadOwners` 判定 owner 死亡时，在 `endTakeover(key, true)` 之后调用 `forgetTab(key)`；
  `takeover.end(key)`（body-only unmount）不清理，保证"打开文件再返回"记录仍在。
- 现有 `forget(key)` 保留（单键清理/测试用）。

## Implementation（阶段、退出闸门与验收）

| 阶段 | 提交 | 内容 | 退出闸门 |
| --- | --- | --- | --- |
| P0 | `docs(plan)` | 本文件（含四条核验、D1–D4、阶段与验收） | `pnpm docs:check` 绿 |
| P1 | `fix(client): save search settings draft when its toggle closes it` | D1 + 测试：打开设置 → 添加规则 → 点 toggle 关闭 → 后续搜索的 excludedPaths 含新规则；Esc 关闭同样保存 | focused vitest（client-search）绿；lint/typecheck 绿 |
| P2 | `fix(client): keep search expansion and scroll across a body remount` | D2 + 测试：同一查询 remount 不新增 run、折叠目录与 scrollTop 保留；查询/筛选/重试变化仍重跑并重置 | focused vitest（client-search、search-state）绿；lint/typecheck 绿 |
| P3 | `fix(host): preserve workspace-file failure codes from the search endpoint` | D3 + 测试：search 以上游 workspace-file 码拒绝 → channel 应答保留该码；未知异常仍 `panel/internal` | focused vitest（command、workspace-routing、contract）绿；lint/typecheck 绿 |
| P4 | `fix(client): scope search records to their session and tab owner` | D4 + 测试：两 session 记录隔离；tab owner 死亡清空该 tab 记录且保留其他 tab；body unmount 保留 | focused vitest（search-state、新 ownership、client-switcher/navigator 回归）绿；lint/typecheck 绿 |
| P5 | `docs: review-fix evidence + PR body` | ADR-0041 修订一句（请求身份/所有权）、FORK.md 搜索段、§7 证据与进度总账；PR 描述更新 | 全门禁 + CI 全绿（记录 run URL） |

## Validation（总验收标准）

1. **A1 草稿不丢**：浮层内编辑规则后点 toggle 关闭，`preferences.source(root)` 的规则已更新，且下一次搜索请求的 `excludedPaths` 包含新规则；Esc 与点击外部两条旧路径无回归。
2. **A2 位置保留**：搜索 → 折叠一个目录 → 滚动 → body 卸载 → 重挂载：run 调用次数不增，折叠状态与 scrollTop 与卸载前一致；改变查询或筛选后会重跑并重置（原语义）。
3. **A3 失败码**：workspace-file 拒绝在 channel 应答中原样保留 code（用于客户端本地化）；未列入白名单的异常仍是 `panel/internal`。
4. **A4 所有权**：两个 session 的 inject product 持有不同 store；tab owner 死亡后该 tab 各根记录全删、其他 tab 不受影响；body-only unmount 不删。
5. **A5 全量门禁**：`pnpm lint` / `typecheck` / `build` / `test`（17 个本机沙箱 authority/lease 失败为基线已知，见完成计划）/ `docs:check` / `pack:check` 通过；PR #56 的 CI 在最终 head 全绿。
6. 所有新增测试在旧宿主 lane 不依赖新结构（搜索 seat 的测试只在 stub/搜到席位的组合里跑）。

## Risks / 回滚

- **跳过条件过宽**（D2）：requestKey 覆盖 rootId/query/excludedPaths/includeHidden/respectGitignore/attempt 全部字段；查询/筛选/重试变化必重跑，且有测试钉住。
- **误删 body unmount 记录**（D4）：只在 `dropDeadOwners` 的 owner 死亡分支清理，`end()` 路径不清理；测试区分三种场景。
- **错误码白名单**（D3）：仅上游声明的 workspace-file 码；不认识的 code 仍归一，避免把任意错误文本当协议暴露。
- 回滚：四个修复相互独立，均为小提交；回退对应提交即恢复原行为，数据/协议无迁移。

## Documentation Impact

- ADR-0041：补"请求身份（重挂载复用）与记录所有权（session 私有 + tab 死亡清理）"的修订说明。
- `src/client/files-tree/FORK.md`：搜索面同步义务里补充记录所有权与请求身份的位置。
- 本计划移入 `docs/plans/completed/`；进度总账追加一行；PR #56 描述更新验收证据。

## Completion Criteria

- §Validation 的 A1–A4 均落地为可执行测试并通过；
- A5 全量门禁通过，且 PR #56 的 CI 在最终提交上全绿（run URL 记录于 §7）；
- 计划、ADR 修订、FORK.md、总账与 PR 描述齐备。

## 7. 进度与证据

| 阶段 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| P0 | 已完成 | `00c29e8` | 本文件四条核验 + D1–D4；`pnpm docs:check` 0 errors（链接修正后） |
| P1+P2 | 已完成 | `eb8a430` | `vitest run tests/client-search.spec.tsx tests/client-search-state.spec.ts` → 14 + 5 passed；新增回归：settings toggle 关闭保存草稿、remount 不新增 run 且折叠/scrollTop 保留、请求身份 6 字段独立、失败重试不会自动循环；`pnpm lint` 0；`pnpm typecheck` 0 |
| P3 | 已完成 | `909ec2e` | `vitest run tests/command.spec.ts` → 75 passed（新增：`workspace-file/outside-workspace` 与 `search-failed` 原码透传、未知异常仍 `panel/internal`）；`tests/workspace-routing.spec.ts` 28 passed；typecheck 0 |
| P4 | 已完成 | `83a87f5` | 客户端套件 137 passed（`client-search` 14、`client-search-state` 5、`client-search-ownership` 3、files 17、switcher 29、navigator 24、styles 35、bundle 10）；ownership 覆盖：session 隔离、tab 死亡清空该 tab 全部根记录、body unmount 保留；lint 0；typecheck 0 |
| P5 | 进行中 | 待推送 | 全门禁与 CI 结果见下方"最终证据" |

> 说明：P1 与 P2 共用 `pane.tsx`/`search-state.ts` 的同一处 effect 语义，拆成两个提交会让中途一个提交的测试红，故合并为 `eb8a430`；
> P3/P4 各自单提交。
