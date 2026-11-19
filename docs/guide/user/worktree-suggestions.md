# Worktree 附加根建议

English: [worktree-suggestions.en.md](./worktree-suggestions.en.md)

主根本身是 Git worktree 根时，插件会发现同一仓库的其它 worktree，并把它们作为候选，等你确认后登记为附加根。如果会话本身是 linked worktree 且处于 `workspace-write`，该仓库的主 checkout 也会作为候选出现在同一张卡片里。

发现只读取 Git 元数据（`.git` 指针、admin、common 的 config/HEAD/index 与祖先链），不启动 Git 子进程，也**不会自动添加或删除根**。

## 开启

侧栏「插件」→ Multi-root Workspace 详情页 → 设置卡 → **启用 Worktree 附加根建议**，默认关闭。关闭后停止发现、提示与专用清理；已经登记的根仍按普通根管理。

## 提示与确认

- 有候选时出现常驻卡片：可以选择「查看」或「稍后提醒」（直到出现新 worktree / 7 天后 / 30 天后）。
- 卡片右上角的关闭按钮只关闭本次提示，重启后会重新出现；在确认框中选择「永久不再提示」才会长期忽略。
- 提示关闭后，可以从「工作区目录」对话框的「重试」旁打开「Worktree 建议」再次查看。
- 确认框逐行显示路径、检测到的分支和权限。权限默认 `inherit`，可以逐行改为只读或读写；候选多于一个时可以勾选多个。
- 主 checkout 行会额外说明它的范围：主 checkout 源码树、共享 config/hooks/refs/objects 与所有 worktree 的 admin 数据，可能影响同仓库的其它 checkout。
- 登记是 workspace 级的：同一 workspace 的其它可读写会话也会获得所选权限。
- 确认时会在串行队列中再次校验；等待期间任何变化都会让该项失效，其余项继续处理。

`danger-full-access` 会话不显示该提示；`read-only` 会话只会出现普通 worktree 候选，主 checkout 不会出现。

## 删除与清理

- worktree 被删除或移动后，对话框会显示徽标，但**不会自动清理**。
- 只有登记路径被确认缺失、且登记身份未变时，才提供清理入口：批量入口在「附属工作目录」标题右侧，单行入口在可清理行的末尾。
- 清理需要在覆盖对话框的确认框中确认。清理前，同一路径出现的新目录可能继承旧授权，确认框会披露这个风险。
- 不需要的登记用普通 Remove 撤回；专用清理只针对受跟踪的 worktree 根。
