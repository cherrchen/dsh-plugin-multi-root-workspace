/**
 * The panel's bilingual copy.
 *
 * Flat `Record<string, string>` dictionaries keyed by a bare key (never
 * `ns.key`), `zh` as the canonical shape and `en` pinned to it by `satisfies`,
 * so a missing translation is a type error and a divergence is caught by
 * `tests/locale-parity.spec.ts` as well.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/locales
 */

/** The locale namespace this plugin owns. */
export const NS = 'multiRootWorkspace'

/** Chinese copy (the canonical shape). */
export const zh = {
  'action.label': '工作区目录',
  'action.title': '管理本会话的附加工作区根目录',
  'panel.title': '工作区目录',
  'panel.subtitle': '主根始终可写；附加根与它同权，但可以随时增删。',
  'panel.primary': '主根',
  'panel.primaryNote': '（本会话的工作目录，不可移除）',
  'panel.additional': '附加根',
  'panel.empty': '还没有附加根。',
  'panel.emptyHint': '添加后，Agent 的 read / write / bash 都能在同一个会话里操作该目录。',
  'panel.loading': '正在读取…',
  'panel.retry': '重试',
  'panel.close': '关闭',
  'panel.add': '添加目录…',
  'panel.addManual': '输入绝对路径',
  'panel.addConfirm': '添加',
  'panel.remove': '移除',
  'panel.removeConfirm': '确认移除',
  'panel.alias': '别名',
  'panel.aliasPlaceholder': '显示名（留空清除）',
  'panel.aliasSave': '保存',
  'panel.aliasCancel': '取消',
  'panel.copyPath': '复制路径',
  'panel.copied': '已复制',
  'panel.reveal': '在文件管理器中显示',
  'panel.moveUp': '上移',
  'panel.moveDown': '下移',
  'state.available': '可写',
  'state.missing': '目录不存在，暂不授予',
  'state.redirected': '登记目录已被替换（现在指向别处），暂不授予',
  'state.invalid': '登记无效',
  'error.not-absolute': '请给出绝对路径（或 ~/ 开头的路径）。',
  'error.missing': '该目录不存在。',
  'error.not-a-directory': '该路径不是目录。',
  'error.equals-primary': '这就是本会话的工作目录，无需重复添加。',
  'error.primary-overlap': '该目录与主根互相包含，不会带来新的可写范围。',
  'error.duplicate': '该目录已经登记过了。',
  'error.nested': '该目录与已登记的根互相包含，不会带来新的可写范围。',
  'error.invalid-alias': '别名不能包含控制字符，且不能过长。',
  'error.not-found': '没有找到对应的登记项。',
  'error.invalid-ref': '请求缺少必要的标识。',
  'error.storage-unavailable': '根目录登记的存储不可用，请检查 $DSH_HOME/storages 下的文件。',
  'error.reveal-unavailable': '无法打开系统的文件管理器；登记项不受影响，路径仍可复制。',
  'error.unavailable': '无法连接到 dsh 主进程。',
  'error.copy-failed': '无法写入剪贴板，请检查浏览器的剪贴板权限。',
  'error.fallback': '操作失败。',
} satisfies Record<string, string>

/** The canonical key set. */
export type Key = keyof typeof zh

/** English copy, pinned to the Chinese key set. */
export const en = {
  'action.label': 'Folders',
  'action.title': 'Manage this session\'s additional workspace roots',
  'panel.title': 'Workspace folders',
  'panel.subtitle': 'The primary root is always writable; additional roots are its equals, and can be added or removed at any time.',
  'panel.primary': 'Primary',
  'panel.primaryNote': '(this session\'s working directory, not removable)',
  'panel.additional': 'Additional roots',
  'panel.empty': 'No additional roots yet.',
  'panel.emptyHint': 'Once added, the agent can read, write, and run bash in that directory from this same session.',
  'panel.loading': 'Loading…',
  'panel.retry': 'Retry',
  'panel.close': 'Close',
  'panel.add': 'Add folder…',
  'panel.addManual': 'Enter an absolute path',
  'panel.addConfirm': 'Add',
  'panel.remove': 'Remove',
  'panel.removeConfirm': 'Confirm removal',
  'panel.alias': 'Alias',
  'panel.aliasPlaceholder': 'Display name (empty clears it)',
  'panel.aliasSave': 'Save',
  'panel.aliasCancel': 'Cancel',
  'panel.copyPath': 'Copy path',
  'panel.copied': 'Copied',
  'panel.reveal': 'Reveal in file manager',
  'panel.moveUp': 'Move up',
  'panel.moveDown': 'Move down',
  'state.available': 'Writable',
  'state.missing': 'Directory is absent; not granted',
  'state.redirected': 'Registration was replaced (it now points elsewhere); not granted',
  'state.invalid': 'Registration is unusable',
  'error.not-absolute': 'Give an absolute path (or one starting with ~/).',
  'error.missing': 'That directory does not exist.',
  'error.not-a-directory': 'That path is not a directory.',
  'error.equals-primary': 'That is this session\'s workspace root; it needs no registration.',
  'error.primary-overlap': 'That directory and the workspace root contain each other, so it grants nothing new.',
  'error.duplicate': 'That directory is already registered.',
  'error.nested': 'That directory and a registered root contain each other, so it grants nothing new.',
  'error.invalid-alias': 'An alias may not contain control characters or be overly long.',
  'error.not-found': 'No registration matches that reference.',
  'error.invalid-ref': 'The request is missing a required identity.',
  'error.storage-unavailable': 'The root registry store is unavailable; check the files under $DSH_HOME/storages.',
  'error.reveal-unavailable': 'Could not open the system file manager; the registration is untouched, and the path can still be copied.',
  'error.unavailable': 'Could not reach the dsh host process.',
  'error.copy-failed': 'Could not write to the clipboard; check the browser\'s clipboard permission.',
  'error.fallback': 'The operation failed.',
} satisfies Record<Key, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's panel copy. */
    multiRootWorkspace: Key
  }
}
