# 访问级别

English: [access-levels.en.md](./access-levels.en.md)

每个附加根都有自己的访问级别；访问级别只决定写权限，不限制读取。新登记的根默认 `inherit`。

## 三种级别

| 访问级别 | `workspace-write` 会话 | `read-only` 会话 | `danger-full-access` 会话 |
| --- | --- | --- | --- |
| `inherit`（跟随会话） | 可写 | 拒写 | 不受限 |
| `read-only`（仅可查看） | 拒写 | 拒写 | 拒写（包括 Full-access） |
| `read-write`（工作区内修改） | 可写 | 可写 | 可写 |

## 怎么切换

- 命令：`/workspace-folders access <序号|路径> inherit|read-only|read-write`。
- 对话框：在「工作区目录」中打开某一行的访问权限菜单，选择级别；扩权时会要求确认。
- 扩权（改成 `inherit` 或 `read-write`）要求该根此刻可用；`missing` 或 `redirected` 的根需要先恢复。

## 一次性提权

用户在单次工具调用上批准 `danger-full-access` 时，这一次调用可以写原本只读的附加根，也不受 per-tool 封顶限制。它只影响这一次调用；`$DSH_HOME` 与 Registry 失权的降级仍按原规则生效。

## 生效范围

- 权限变化只约束之后的调用与新进程。已经启动的进程和持久终端保留启动时的权限；需要新权限时重启终端。
- 每个主根最多登记 16 个附加根。宿主配置 `maxAdditionalRoots` 可以把它提高到 64；超出的新增会被拒绝，已有登记不受影响。
- 宿主可以在 `multi-root-scope` 行配置 `toolAccess`，按工具永久封顶。例如 `{ bash: 'read-only' }` 让 bash 不能写任何附加根，但仍可写主根。
- 只读根开启 Skills 后仍然没有写权限；Skills 开关与访问级别相互独立。
