// SPDX-License-Identifier: GPL-2.0-or-later
// Detect TDZ (Temporal Dead Zone) errors in React hook dependency arrays.
//
// Scans all .ts/.tsx files for React hook calls (useEffect, useCallback, etc.)
// and checks if any identifier in the dependency array (2nd argument) is
// defined AFTER the hook call in the source file. Such references cause a
// runtime ReferenceError because const/let variables cannot be accessed
// before their declaration.
//
// Usage: npx tsx scripts/check-hook-deps-tdz.ts

import * as ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const HOOK_NAMES = new Set([
  'useEffect',
  'useCallback',
  'useMemo',
  'useLayoutEffect',
  'useImperativeHandle',
])

interface Violation {
  file: string
  hookName: string
  hookLine: number
  varName: string
  varLine: number
  depLine: number
}

function collectFiles(dir: string, extensions: string[]): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out' || entry.name === '__tests__') continue
      files.push(...collectFiles(full, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full)
    }
  }
  return files
}

function getLineNumber(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1
}

/**
 * Collect top-level const/let variable declarations in a function body.
 * Only collects declarations at the direct block scope level — ignores
 * declarations inside nested blocks (if/for/etc.) to avoid false positives
 * from shadowed names.
 */
function collectDeclarations(
  body: ts.Block,
  sourceFile: ts.SourceFile,
): Map<string, number> {
  const decls = new Map<string, number>()

  for (const stmt of body.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const declList = stmt.declarationList
    // Only const/let have TDZ (var is hoisted)
    if (!(declList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) continue

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

  return decls
}

/**
 * Recursively extract the root identifier from any expression.
 * Handles: identifier, obj.prop, obj?.prop, obj.a.b.c, obj!.prop, etc.
 */
function extractRootIdentifier(node: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(node)) return node
  if (ts.isPropertyAccessExpression(node)) return extractRootIdentifier(node.expression)
  if (ts.isNonNullExpression(node)) return extractRootIdentifier(node.expression)
  if (ts.isParenthesizedExpression(node)) return extractRootIdentifier(node.expression)
  if (ts.isAsExpression(node)) return extractRootIdentifier(node.expression)
  return undefined
}

/** Extract identifiers from a dependency array expression */
function extractDepsIdentifiers(
  depsArray: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
): Array<{ name: string; pos: number }> {
  const ids: Array<{ name: string; pos: number }> = []
  for (const el of depsArray.elements) {
    const root = extractRootIdentifier(el)
    if (root) {
      ids.push({ name: root.text, pos: root.getStart(sourceFile) })
    }
  }
  return ids
}

function checkFile(filePath: string): Violation[] {
  const source = readFileSync(filePath, 'utf-8')
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind)
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
          // useImperativeHandle has deps as 3rd arg, others as 2nd
          const depsArgIndex = hookName === 'useImperativeHandle' ? 2 : 1
          const depsArg = node.arguments[depsArgIndex]
          if (depsArg && ts.isArrayLiteralExpression(depsArg)) {
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
const files = collectFiles(srcDir, ['.ts', '.tsx'])
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
