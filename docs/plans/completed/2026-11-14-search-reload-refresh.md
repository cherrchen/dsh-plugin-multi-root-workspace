# 附加根搜索：reload 按钮应刷新正在展示的搜索（R6）

> 状态：已完成（2026-11-14）。本文件是修复计划与执行账本。
>
> 分支：`feat/addtional-file-tree-1114`（PR [#56](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/56)）。
> 关联：[ADR-0041](../../decisions/ADR-0041-additional-root-workspace-search.md)、[上一轮 review 修复](../completed/2026-11-14-files-parity-review-fixes.md)。

## Goal

让 Files 页头的 reload 在搜索结果显示时真正刷新搜索：用户无需改查询/筛选即可重新取一次当前请求的结果；
树在展示时保持原有 re-list 行为不变。

## Background（核验）

Codex review（PR #56，reviewed commit `13d8ae6`）结论**成立**：

| # | Review 结论 | 位置 | 判定 |
| --- | --- | --- | --- |
| R6 | 搜索结算后，页头 reload 无法取到文件系统变化；reload 只调 `filesTree.face.refresh()`，而展示搜索结果时 `FilesTree` 未挂载，face 的目录节点已被 release，refresh 成为 no-op；搜索又保留同一请求身份并在重挂载时跳过重跑 | `src/client/RootSwitcher.tsx` reload 的 onClick；`src/client/files-tree/pane.tsx` effect 的 settledKey 跳过 | 成立。搜索结果视图只挂 `TreeView`（无 `FilesTree`），`face.refresh(tabId)` 没有可刷新的目录节点；同时 `search-state` 的 `settledKey` 使同一请求不会自动重跑。用户只能改查询/筛选才能更新结果。 |

## Design

- **store 增加刷新意图**：`SearchPaneStore.refresh(key)`：仅当该 pane root 有非空查询时，把 `settledKey` 清空、`attempt + 1`、`pending = true`，
  **保留**当前结果、展开与滚动（刷新期间旧结果继续显示，新答案到达后按既有语义替换）。
  空查询时不做事——列出的树由 face 的 re-list 负责。
- **页头 reload 同时驱动两者**：`RootSwitcher` 的 reload 先保持原行为 `filesTree.face.refresh(tabId)`（树在展示时立即 re-list），
  再在搜索 seat 与 key 存在时调用 `store.refresh(searchKey)`。搜索视图下前者自然为 no-op，后者重跑当前请求；
  重挂载后的同一搜索同样能刷新，因为 attempt 变化使请求身份变化、effect 会重跑。
- 不改请求字段、不改偏好、不新增端点；不改变 reload 在无搜索时的行为。

## Implementation

| 阶段 | 提交 | 内容 | 退出闸门 |
| --- | --- | --- | --- |
| P0 | `docs(plan): reload refreshes the active search (R6)` | 本文件 | `pnpm docs:check` 绿 |
| P1 | `fix(client): let the header reload refresh the active search` | store 的 `refresh` + `RootSwitcher` 接线 + 测试：store 单测（有查询时 attempt/settledKey/pending 变化且保留结果与位置；空查询 no-op）；client-switcher 集成（搜索结算后点 reload，channel 以同一 query/root 再次调用，且树 reload 行为不回归） | focused vitest 绿；lint/typecheck 绿 |
| P2 | `docs: record R6 evidence` | ADR-0041 补一句 reload 语义；本计划移入 completed；PR 描述更新 | 全量门禁 + PR CI 全绿（记录 run URL） |

## Validation（验收）

1. **A1**：搜索结算后点页头 reload，channel 收到同一 `{rootId, query, excludedPaths, includeHidden, respectGitignore}` 的第二次请求；结果最终替换，无需改查询。
2. **A2**：无活动搜索（清空查询）时 reload 仍只 re-list 树，不产生 search 请求。
3. **A3**：body 重挂载后（settledKey 命中）点 reload 同样会重跑。
4. **A4**：现有 client-switcher 的树 reload 用例、client-search 的展开/滚动、失败重试用例不回归。
5. **A5**：`pnpm lint` / `typecheck` / `build` / `docs:check` / `pack:check` 与 PR #56 的 CI 全绿（记录 run URL）。

## Risks / 回滚

- 误对空查询发请求：store 的 `refresh` 在 `query.trim() === ''` 时直接返回；测试钉住。
- 刷新期间丢位置：`refresh` 刻意不重置 result/expanded/scrollTop；重置只发生在新的结算答案上。
- 回滚：单提交回退即恢复"reload 只 re-list 树"的旧行为，无数据/协议迁移。

## Documentation Impact

- ADR-0041 D3 修订补一行：页头 reload 在活动搜索时重跑当前请求；FORK.md 无需改（搜索面同步清单不含交互接线）。
- 本计划移入 `docs/plans/completed/`；进度总账追加一行；PR 描述记录 R6 与 CI。

## 7. 进度与证据

| 阶段 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| P0 | 已完成 | `1dbb201` | 本文件；`pnpm docs:check` 0 errors |
| P1 | 已完成 | `79a902b` | store `refresh`（有查询才动作、保留结果/展开/滚动，attempt+1、settledKey 清空）+ RootSwitcher reload 接线；`vitest run tests/client-search-state.spec.ts tests/client-switcher.spec.ts` → 7 + 30 passed；相邻套件 58 passed；lint 0；typecheck 0；build 绿 |
| P2 | 已完成 | `待 docs 提交` | 计划收尾、ADR 注记、总账与 PR 描述；CI run [https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43606644577](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43606644577) 在 `79a902b` 上 31/31 checks 全绿 |

## 8. 最终证据

- 提交：`1dbb201`（计划）、`79a902b`（R6 修复）；均在同一 PR 分支上。
- CI：head `79a902b` 的 run [https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43606644577](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/43606644577) 通过 releases + 24 条 release/image verify 与 gate，合计 31/31 checks；本机残留的 17 个 sandbox-IPC authority/lease 失败与基线 `8c09c7b` 同因，CI 的非沙箱 runner 全部通过。
