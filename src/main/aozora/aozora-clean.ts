// SPDX-License-Identifier: GPL-2.0-or-later
//
// TypeScript port of the aozorabunko-extractor cleaning pipeline
// (globis-org/aozorabunko-extractor). Turns a raw Aozora Bunko text
// (already decoded from Shift_JIS to a JS string) into plain text
// suitable for the typing-test fileImport flow: ruby, gaiji notation,
// input-editor annotations and the title/legend/colophon boilerplate
// are stripped while paragraph structure is preserved verbatim.
//
// Every function here is pure (no I/O) so the pipeline can be unit
// tested step by step in addition to the composite entry point,
// cleanAozoraText.

/** Normalizes CRLF and lone CR line endings to LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// The annotation-legend block only ever sits right after the title/author
// block, near the top of the file. Requiring its opening dash line to start
// within this many lines of the file keeps removeHeader from matching a
// dashed horizontal rule that legitimately occurs later in the body (e.g. a
// scene break), which would otherwise delete everything between two such
// rules.
const HEADER_SCAN_LIMIT = 30

/**
 * Drops the leading title/author block (the first run of non-blank
 * lines at the very start of the file) and, if present, the
 * annotation-legend block delimited by two horizontal-rule lines of
 * 30+ dashes whose opening rule starts within the first
 * HEADER_SCAN_LIMIT lines of the file.
 */
export function removeHeader(text: string): string {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() !== '') i++
  const bodyLines = lines.slice(i)

  const isDashRule = (line: string): boolean => /^-{30,}$/.test(line)
  // Convert the absolute (whole-file) scan limit into an index relative to
  // bodyLines, which starts after the title block at line `i`.
  const scanEnd = Math.max(0, HEADER_SCAN_LIMIT - i)
  const openIdx = bodyLines.findIndex((line, idx) => idx < scanEnd && isDashRule(line))
  if (openIdx === -1) return bodyLines.join('\n')

  const closeIdx = bodyLines.findIndex((line, idx) => idx > openIdx && isDashRule(line))
  if (closeIdx === -1) return bodyLines.join('\n')

  return [...bodyLines.slice(0, openIdx), ...bodyLines.slice(closeIdx + 1)].join('\n')
}

/**
 * Cuts everything from whichever comes first: the colophon marker (底本：
 * or 底本:, optionally indented) or an explicit end-of-body marker
 * （［＃本文終わり］, which is removed along with everything after it).
 */
export function removeFooter(text: string): string {
  const colophon = text.search(/^[ \t　]*底本[：:]/m)
  const endOfBody = text.search(/^.*［＃本文終わり］.*$/m)
  const candidates = [colophon, endOfBody].filter((idx) => idx !== -1)
  if (candidates.length === 0) return text
  return text.slice(0, Math.min(...candidates))
}

/**
 * Resolves inline notes: ［＃割り注］X［＃割り注終わり］ becomes
 * （X）, unless X is already wrapped in full-width parens.
 */
export function resolveWarichu(text: string): string {
  return text.replace(/［＃割り注］([\s\S]*?)［＃割り注終わり］/g, (_full, content: string) => {
    if (/^（[\s\S]*）$/.test(content)) return content
    return `（${content}）`
  })
}

/**
 * Removes ruby annotations: 《…》 spans and the U+FF5C ruby-start
 * marker.
 */
export function removeRuby(text: string): string {
  return text.replace(/《[^》]*》|｜/g, '')
}

/**
 * Resolves gaiji (non-standard character) notation: ※［＃…］. When
 * the bracket content carries a U+XXXX code point it is substituted
 * in directly; otherwise (menkuten-only references such as
 * "第3水準1-14-8") the whole token is dropped and the surrounding
 * line is kept intact.
 */
export function resolveGaiji(text: string): string {
  return text.replace(/※［＃([^］]*)］/g, (_full, content: string) => {
    const match = content.match(/U\+([0-9A-Fa-f]{4,6})/)
    if (!match) return ''
    return String.fromCodePoint(parseInt(match[1], 16))
  })
}

/**
 * Converts kunojiten repeat marks. The three-character form must be
 * converted before the two-character form, otherwise ／″＼ would be
 * partially matched by the ／＼ pattern.
 */
export function convertRepeatMarks(text: string): string {
  return text.replace(/／″＼/g, '〴〵').replace(/／＼/g, '〳〵')
}

/**
 * Removes remaining input-editor annotations: ［＃…］. Nested
 * annotations are resolved by repeatedly stripping the innermost
 * bracket-free span until none remain. Plain brackets without a
 * leading ＃ (e.g. ［ordinary text］) are left untouched.
 */
export function removeAnnotations(text: string): string {
  let result = text
  while (/［＃[^［］]*］/.test(result)) {
    result = result.replace(/［＃[^［］]*］/g, '')
  }
  return result
}

/** Strips the Unicode replacement character (U+FFFD). */
export function stripReplacementChar(text: string): string {
  return text.replace(/�/g, '')
}

/**
 * Trims leading/trailing blank lines and drops any line that
 * consists solely of horizontal-rule characters (-, ＝, =, ―).
 */
export function trimEdges(text: string): string {
  const isRuleLine = (line: string): boolean => /^[-＝=―]+$/.test(line.trim())
  const lines = text.split('\n').filter((line) => !isRuleLine(line))
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end).join('\n')
}

/**
 * Runs the full aozorabunko-extractor cleaning pipeline on a raw
 * Aozora Bunko text and returns plain text ready for the fileImport
 * typing-test flow.
 */
export function cleanAozoraText(raw: string): string {
  let text = normalizeNewlines(raw)
  text = removeHeader(text)
  text = removeFooter(text)
  text = resolveWarichu(text)
  text = removeRuby(text)
  text = resolveGaiji(text)
  text = convertRepeatMarks(text)
  text = removeAnnotations(text)
  text = stripReplacementChar(text)
  text = trimEdges(text)
  return text
}
