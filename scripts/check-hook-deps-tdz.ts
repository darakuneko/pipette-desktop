// SPDX-License-Identifier: GPL-2.0-or-later
// Detect TDZ (Temporal Dead Zone) errors in React hook dependency arrays.
//
// Scans all .tsx files for useEffect/useCallback/useMemo/useLayoutEffect calls
// and checks if any identifier in the dependency array (2nd argument) is defined
// AFTER the hook call in the source file. Such references cause a runtime
// ReferenceError because const/let variables cannot be accessed before their
// declaration.
//
// Usage: npx tsx scripts/check-hook-deps-tdz.ts

import * as ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const HOOK_NAMES = new Set([
  'useEffect',
  'useCallback',
  'useMemo',
  'useLayoutEffect',
])

interface Violation {
  file: string
  hookName: string
  hookLine: number
  varName: string
  varLine: number
  depLine: number
}

function collectFiles(dir: string, ext: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
      files.push(...collectFiles(full, ext))
    } else if (entry.name.endsWith(ext)) {
      files.push(full)
    }
  }
  return files
}

function getLineNumber(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1
}

/** Collect all const/let variable declarations in a function body */
function collectDeclarations(
  body: ts.Block,
  sourceFile: ts.SourceFile,
): Map<string, number> {
  const decls = new Map<string, number>()

  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      const declList = node.declarationList
      // Only const/let have TDZ (var is hoisted)
      if (declList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) {
        for (const decl of declList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            decls.set(decl.name.text, decl.getStart(sourceFile))
          }
          // Destructuring patterns
          if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
            for (const el of decl.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                decls.set(el.name.text, el.getStart(sourceFile))
              }
            }
          }
        }
      }
    }
    // Don't descend into nested functions — they have their own scope
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(body, visit)
  return decls
}

/** Extract identifiers from a dependency array expression */
function extractDepsIdentifiers(
  depsArray: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
): Array<{ name: string; pos: number }> {
  const ids: Array<{ name: string; pos: number }> = []
  for (const el of depsArray.elements) {
    if (ts.isIdentifier(el)) {
      ids.push({ name: el.text, pos: el.getStart(sourceFile) })
    }
    // Handle member expressions like obj.prop — check the root identifier
    if (ts.isPropertyAccessExpression(el) && ts.isIdentifier(el.expression)) {
      ids.push({ name: el.expression.text, pos: el.expression.getStart(sourceFile) })
    }
  }
  return ids
}

function checkFile(filePath: string): Violation[] {
  const source = readFileSync(filePath, 'utf-8')
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: Violation[] = []

  function visitFunction(body: ts.Block): void {
    const decls = collectDeclarations(body, sourceFile)

    // Find hook calls in this function body (not nested)
    function findHookCalls(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        let hookName: string | undefined
        if (ts.isIdentifier(node.expression)) {
          hookName = node.expression.text
        }
        if (hookName && HOOK_NAMES.has(hookName) && node.arguments.length >= 2) {
          const depsArg = node.arguments[1]
          if (ts.isArrayLiteralExpression(depsArg)) {
            const hookPos = node.getStart(sourceFile)
            const depIds = extractDepsIdentifiers(depsArg, sourceFile)

            for (const dep of depIds) {
              const declPos = decls.get(dep.name)
              // TDZ: dependency array reference position < variable declaration position
              if (declPos !== undefined && dep.pos < declPos) {
                violations.push({
                  file: filePath,
                  hookName,
                  hookLine: getLineNumber(sourceFile, hookPos),
                  varName: dep.name,
                  varLine: getLineNumber(sourceFile, declPos),
                  depLine: getLineNumber(sourceFile, dep.pos),
                })
              }
            }
          }
        }
      }
      // Don't descend into nested functions
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        return
      }
      ts.forEachChild(node, findHookCalls)
    }

    ts.forEachChild(body, findHookCalls)
  }

  function visit(node: ts.Node): void {
    // Find function bodies (component functions, custom hooks)
    if (ts.isFunctionDeclaration(node) && node.body) {
      visitFunction(node.body)
    }
    if (ts.isFunctionExpression(node) && node.body) {
      visitFunction(node.body)
    }
    if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
      visitFunction(node.body)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

// --- Main ---

const srcDir = join(process.cwd(), 'src')
const files = collectFiles(srcDir, '.tsx')
const allViolations: Violation[] = []

for (const file of files) {
  allViolations.push(...checkFile(file))
}

if (allViolations.length === 0) {
  console.log('No TDZ issues found in hook dependency arrays.')
  process.exit(0)
} else {
  console.error(`Found ${allViolations.length} TDZ issue(s) in hook dependency arrays:\n`)
  for (const v of allViolations) {
    const rel = relative(process.cwd(), v.file)
    console.error(
      `  ${rel}:${v.depLine}  error  "${v.varName}" is referenced in ${v.hookName} ` +
      `dependency array (line ${v.depLine}) but defined later (line ${v.varLine})`,
    )
  }
  console.error('')
  process.exit(1)
}
