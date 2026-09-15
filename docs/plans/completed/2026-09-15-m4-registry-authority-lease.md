# M4：跨进程 Registry Authority Lease

> 编号口径：本计划是 `v0.1.1` 硬化批次的 **H1**（路线图编号 **M4**，二者指同一件事）；批次总账见[路线图](../active/2026-09-12-multi-root-workspace.md#进度总账)。

## Goal

关掉「两个 DSH 进程共享同一 storage root 时，一方撤销的附加根另一方仍继续 grant」的 P0：同一时刻只允许一个 Registry Authority Process 打开 `multi_root_workspace` domain；争用 fail-closed；前一个进程退出或崩溃后，等待方通过 `refresh()` 接管并读回最后一次 durable mutation。

## Background

核实结论（对照当前 `src/registry.ts`、`@deepseek-ai/dsh-storage-json` 与 session JSONL lease）：

- `chains` 只串行化同一进程、同一 primary root 的 mutation，这部分仍然正确。
- JSON backend 启动时读入一次，之后内存 authoritative，每次写整份 atomic rewrite；`open`/`opening` 排他是进程内 Map。
- `refresh()` 重新分类的是本进程 storage handle 的内存状态，不会重新读磁盘。
- 上游 Session persistence 已经用 flock / named semaphore 表达「单写者 + kernel 在进程死亡时释放」，值得沿用而不是造 PID/TTL 锁。

详见 [ADR-0007](../../decisions/ADR-0007-registry-authority-lease.md)。

## Current State

本计划实施完成。M1/M2/M3 行为保持不变；本里程碑只增加 store-wide 内核 lease 与 fail-closed authority 状态。

## Scope

- `src/registry-lease.ts` + `src/registry-lease-win32.ts`：POSIX flock 与 Windows named semaphore。
- `MultiRootRegistry` 生命周期：acquire → open → publish → close → release；`refresh()` 调用 `ensureAuthority()`。
- `RegistryAuthorityState`：`active` / `contended` / `storage-failed`。
- patch 配置 `leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')`。
- `tests/registry-lease.spec.ts` 与 `tests/registry-multiprocess.e2e.ts`。

## Non-goals

- 跨进程 CAS / 文件 watch / 多写者合并。
- 上游 storage 暴露 medium identity（长期可用来去掉 `leasePath` 与 `storage-json.root` 的配置耦合）。
- 修改上游任何包。

## Design

见 [ADR-0007](../../decisions/ADR-0007-registry-authority-lease.md)。生命周期：

```text
Service.init
   ↓
acquire lease
   ↓
open multi_root_workspace domain
   ↓
load records → publish multiRootScope
   ↓
        正常运行
   ↓
close domain
   ↓
release lease
```

争用进程：`additionalRoots = []`，mutation 抛 `registry-contended`，面板/命令展示 `unavailable`。A 退出或 SIGKILL 后，B 的 `refresh()` 重新拿 lease、从磁盘 open、读回 A 的最后一次 durable 写。

## Implementation

已落地：`src/registry-lease.ts`、`src/registry-lease-win32.ts`、`src/registry.ts` 的 authority 状态机、`cordis.patch.yml` 的 `leasePath`、错误码 `registry-contended` 与双语文案。

## Validation

- `tests/registry-lease.spec.ts`：同进程双 stack 争用、空 grant、mutation 拒绝、dispose 后 refresh 接管并读回。
- `tests/registry-multiprocess.e2e.ts`：两 OS 进程同时启动、B 绝不获得 stale grants、A 干净退出、A SIGKILL、B 读回最后一次 durable mutation。
- 既有 `tests/registry.spec.ts` 仍先 dispose 再重启，不与 lease 冲突。

## Risks

| 风险 | 处置 |
| --- | --- |
| 自定义 `storage-json.root` 未同步 `leasePath` | fail closed（lease 与介质不对齐时仍单写者，或路径错误导致 storage-failed）；文档要求同步覆盖 |
| Windows CI 默认关闭 | win32 adapter 与上游 session lease 同构；POSIX 腿覆盖 flock 与 multiprocess |
| flock native addon 在安装形态下缺失 | acquire 失败 → `storage-failed`，不 grant |

## Documentation Impact

- ADR-0007（canonical）
- 架构 §3/§7、需求 §5、AGENTS.md 不变量、开发工作流、故障排查条目
- 本计划（completed）

## Completion Criteria

- [x] 争用进程绝不 open domain、绝不 grant
- [x] 前一个进程干净退出后 `refresh()` 接管
- [x] 前一个进程 SIGKILL 后 `refresh()` 接管
- [x] 最后一次 durable mutation 被继任者读回
- [x] `pnpm docs:check` 与相关测试通过
