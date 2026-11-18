# 附属根 Skills

English: [additional-root-skills.md](./additional-root-skills.md)

插件会发现每个附加根里的 Skills，并把它们加上命名空间，避免与主根或其它附加根重名。

## 放在哪里

在每个附加根的以下目录中放置 Skill：

- `.dsh/skills`
- `.agents/skills`

Skill 的名称和描述在会话的第一个模型步骤就能看到；正文在真正调用时才加载，不会一开始就占用上下文。

## 怎么调用

- 主根的 Skill：`/skill-name`
- 附加根的 Skill：`/alias-id:skill-name`，例如 `/payments:deploy`
- 可以在 Slash 菜单中补全，也可以手动输入。
- 模型通过原生 `skill` 工具调用。工具日志中可能出现内部 ID，这是正常的；人类菜单只显示命名空间引用。

## 开关

- 新登记的 `inherit` / `read-write` 根默认开启 Skills；`read-only` 根默认关闭。
- 在「工作区目录」对话框里，每行右侧的技能按钮可以单独开关该根；保存成功后才更新状态。
- 全局开关在侧栏「插件」→ Multi-root Workspace 详情页 → 设置卡 → **启用附属根 Skills**，默认开启。关闭后停止新的发现与调用，但保留每个根自己的选择；重新开启后按原选择恢复。
- 主根 Skills、指令、LSP、文件浏览和沙箱权限不受这个全局开关影响。

## 别名与命名空间

- 显示 Alias 只用于列表展示；修改它不会改变 `aliasId`。
- `aliasId` 是稳定的调用前缀。用 `/workspace-folders alias-id <序号|路径> <kebab-case>` 修改，必须唯一、最长 48 字符。
- 只读根即使开启 Skills，也不会因此获得写权限。
