/** Patch actual tool owners, preserving the composed YAML's !!js conditions. */
import { Document, isMap, isSeq, parseDocument } from 'yaml'

export function baselineProfilePatch(source, applyPatch) {
  const doc = parseDocument(source, { logLevel: 'silent' })
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('G0_BAD_COMPOSITION: expected composed entry rows')
  const patch = []
  for (const row of doc.contents.items) {
    if (!isMap(row)) continue
    if (row.get('id') === 'tool-fs') {
      const config = row.get('config', true)?.clone() ?? new Document({}).contents
      config.set('applyPatch', applyPatch)
      patch.push({ id: row.get('id'), config })
    }
    if (row.get('name') !== '@deepseek-ai/dsh-agent-preset') continue
    const config = row.get('config', true)?.clone()
    const plugins = config?.get('plugins', true)
    if (!isSeq(plugins)) continue
    let changed = false
    for (const plugin of plugins.items) {
      if (!isMap(plugin) || plugin.get('id') !== 'tool-fs') continue
      const toolConfig = plugin.get('config', true) ?? new Document({}).contents
      toolConfig.set('applyPatch', applyPatch); plugin.set('config', toolConfig); changed = true
    }
    if (changed) patch.push({ id: row.get('id'), config })
  }
  if (!patch.some(row => row.id === 'tool-fs')) throw new Error('G0_NO_TOOL_FS_ROW')
  return { yaml: new Document(patch).toString(), targets: patch.map(row => row.id) }
}
