/** G0/ADR-0031: optional SSH backends must never enter a static module graph. */
import ts from 'typescript'

const SSH_PACKAGE = /^@deepseek-ai\/dsh-(?:ssh|fs-ssh|sandbox-ssh|subprocess-ssh)(?:\/|$)/u

/** Parse JavaScript so comments, quoted examples and dynamic imports stay inert. */
export function staticSshImports(source) {
  const file = ts.createSourceFile('packed.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (specifier !== undefined && ts.isStringLiteral(specifier) && SSH_PACKAGE.test(specifier.text)) {
      imports.push(specifier.text)
    }
  }
  return imports
}
