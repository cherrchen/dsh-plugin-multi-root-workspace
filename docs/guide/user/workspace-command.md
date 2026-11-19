# 命令：管理附加根

English: [workspace-command.en.md](./workspace-command.en.md)

`/workspace-folders` 是附加根的文本入口，Web、Desktop 和 headless 中都能使用；不带参数时等同 `list`。`/add-dirs` 是 `add` 的快捷命令。

## 命令一览

```text
/workspace-folders [list]                                                   # 列出主根与附加根（含每根权限与状态）
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # 不带路径时打开目录选择器；新登记默认 inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # /workspace-folders add 的快捷命令
/workspace-folders remove <order|path>                                      # 序号即 list 输出的编号
/workspace-folders access <order|path> inherit|read-only|read-write         # 切换访问级别
/workspace-folders alias <order|path> [alias]                               # 不带别名则清除已有别名
/workspace-folders alias-id <order|path> <kebab-case>                        # 编辑 Skills 的稳定命名空间
/workspace-folders skills <order|path> on|off                               # 单独开关该根的 Skills
/workspace-folders reveal <order|path>                                      # 在文件管理器中显示
/workspace-folders isolate-profiles [--apply]                               # 检查（--apply 则写入）profile 的依赖导入方式
/workspace-folders help                                                     # 查看命令帮助
```

## 添加根

- 不带路径时打开系统目录选择器（宿主提供选择器时）；也可以只给权限参数，例如先输入 `/workspace-folders add --read-only`，再选目录。
- 路径可以带引号，`~` 会展开为家目录。登记前会先规范化：重复、嵌套在已有根内部、主根本身，以及 `$DSH_HOME`、Registry 存储目录等受保护路径都会被拒绝。
- 新登记的根默认使用 `inherit`，即跟随会话的沙箱模式。

## 查看状态

`list` 会显示主根和每个附加根的路径、显示别名、访问级别与状态，并给出已登记数量与当前模式下可写的数量。

目录暂时不存在（`missing`）或被替换成指向别处的链接（`redirected`）时，登记仍然保留，但暂不授予访问；恢复目录或链接后，再执行一次 `list` 或刷新「工作区目录」对话框即可自动恢复，不需要重启。

## 引用某个根

`remove`、`access`、`alias`、`alias-id`、`skills`、`reveal` 都接受 `序号|路径`。序号就是 `list` 输出的编号，路径可以带引号。

- `alias` 修改显示别名，仅影响列表展示；不带别名参数时清除已有别名。
- `alias-id` 修改 Skills 的调用前缀，必须唯一、使用 kebab-case，最长 48 字符。
- `skills` 只控制该根是否提供 Skills，不改变它的写权限。
- `access` 切换访问级别；扩权（改成 `inherit` 或 `read-write`）要求该根此刻可用。

## 排障

- 输出 `Root registry unavailable`：另一个 DSH 进程正持有登记存储。关闭那个进程后再执行命令或点「重试」。
- 根显示 `missing` / `redirected`：恢复目录或链接后再次 `list`；登记不会被自动删除。
- 命令输出固定为英文，因为宿主侧的命令处理没有界面语言信息；对话框中的文案跟随界面语言。

## isolate-profiles（Windows 受限 Full-access）

`/workspace-folders isolate-profiles` 默认只做检查：列出 `$DSH_HOME` 下各 profile 的 `packageImportMethod` 状态，并扫描 profile 依赖的链接情况。加 `--apply` 会把 `packageImportMethod: copy` 写入每个可修复 profile 的 `pnpm-workspace.yaml`。

这个命令只改配置，不会删除 `node_modules`，也不会替你重装依赖；已有硬链接需要按报告中的步骤重新安装后才会变成副本。受限 Full-access 预检拒绝时，可以用它定位并修复 profile。
