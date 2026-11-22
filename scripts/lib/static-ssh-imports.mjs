/** G0/ADR-0031: optional SSH backends must never enter a static module graph. */
import ts from 'typescript'

const SSH_PACKAGE = /^@deepseek-ai\/dsh-(?:ssh|fs-ssh|sandbox-ssh|subprocess-ssh)(?:\/|$)/u

/** Parse JavaScript so comments, quoted examples and dynamic imports stay inert. */
export function staticSshImports(source) {
  return importSpecifiers(source, false).filter(specifier => SSH_PACKAGE.test(specifier))
}

/** Enumerate literal module references without scanning text inside strings. */
export function importSpecifiers(source, includeDynamic = true) {
  const file = ts.createSourceFile('packed.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (specifier !== undefined && ts.isStringLiteral(specifier)) imports.push(specifier.text)
  }
  if (includeDynamic) {
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) {
        imports.push(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(file, visit)
  }
  return imports
}
