// SPDX-License-Identifier: GPL-2.0-or-later
// Inputs for the text functions: hand-picked edge cases plus seeded random
// strings built from tokens that hit the same edges (JavaScript whitespace
// and line terminators, surrogates, the Aozora notations).

import { random32 } from '../fixture-random'

/** Every code unit JavaScript's `\s` matches, plus look-alikes it does not
 *  (U+0085, U+180E, U+200B, U+2060). */
export const WHITESPACE_PROBES = [
  '\t', '\n', '\v', '\f', '\r', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
  ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ',
  '　', '﻿', '\u0085', '᠎', '​', '⁠',
]

function picker(seed: number): { int: (n: number) => number; pick: <T>(items: readonly T[]) => T } {
  const next = random32(seed)
  const int = (n: number): number => next() % n
  return { int, pick: (items) => items[int(items.length)] }
}

export interface NormalizeCase {
  input: string
  maxWords: number
}

export function normalizeCases(): NormalizeCase[] {
  const fixed = [
    '', ' ', '\n', '\r\n', 'a', '  the  quick\t fox ', 'the quick\nbrown fox', 'a\r\n\r\nb\rc', 'a\r\r\nb\n\rc',
    'def f() {\n  val x = 1\n}', 'a b\nc\n\nd e f', 'こんにちは', ' \t\n  \n', '\ud800 a\udc00\n\udfff\ud83d',
    '😀 😀\n\t😀', 'a b c', '﻿a b', 'trailing space \nnext ',
    ...WHITESPACE_PROBES.map((ws) => `${ws}x${ws}y${ws}\n${ws}${ws}z`),
  ]
  const cases: NormalizeCase[] = fixed.map((input) => ({ input, maxWords: 5000 }))
  for (let maxWords = 0; maxWords <= 7; maxWords++) cases.push({ input: 'a b\nc d e\nf\n\ng', maxWords })
  // The 5,000-word cap: a line ending exactly at it, one word past it, and a
  // line cut short by it.
  cases.push({ input: 'a b c d e\n'.repeat(1000) + 'f', maxWords: 5000 })
  cases.push({ input: 'a\n'.repeat(5001), maxWords: 5000 })
  cases.push({ input: 'a '.repeat(4999) + 'b\nc d', maxWords: 5000 })
  cases.push({ input: '  x y\n'.repeat(2501), maxWords: 5000 })

  const tokens = [
    'a', 'bc', 'あ', 'ア', '漢字', '😀', '\ud800', '\udfff', ' ', '  ', '\t', '\n', '\r', '\r\n', '\n\n', '　',
    ' ', '\u0085', '﻿', ' ', ' ', '\v', '\f', '᠎', '​',
  ]
  const { int, pick } = picker(0x7e47)
  for (let n = 0; n < 300; n++) {
    let input = ''
    const length = int(31)
    for (let i = 0; i < length; i++) input += pick(tokens)
    cases.push({ input, maxWords: pick([0, 1, 2, 3, 5, 8, 5000]) })
  }
  return cases
}

export function kanaCases(): string[] {
  const cases = ['', 'あいうえおかきくけこ', 'アイウエオカキクケコ', 'コーヒーをのむ', 'あい う\tえ\nお\r\nか　き',
    '日本語のぶんしょう', 'hello world', 'こんにちは。', 'こんにちは、げんきですか', 'ですか？', 'すごい！', '。。。', '、',
    '？ ！', 'こんにちは「せかい」', 'あ・い', '   \n\t　', 'ゐゑヶヴ', 'ー', 'ーー。', 'あ😀', '😀', '\ud800', 'あ\udc00',
    'あ?', 'あ!', 'あ.', 'あ,', 'ｱ', 'あｰ']
  // Each unit of the kana blocks alone and after a kana, and each
  // whitespace probe with and without kana.
  for (let unit = 0x3000; unit <= 0x30ff; unit++) {
    const char = String.fromCharCode(unit)
    cases.push(char, `あ${char}`)
  }
  for (const ws of WHITESPACE_PROBES) cases.push(ws, `あ${ws}ア`)

  const tokens = ['あ', 'ア', 'ー', 'ヴ', 'ヶ', 'ゖ', 'ゕ', 'ヷ', 'ヺ', '・', '。', '、', '？', '！', '?', ' ', '　',
    '\n', '﻿', '\u0085', '漢', 'a', '😀', '\ud800', 'ゝ', 'ヽ', '゛', '゜']
  const { int, pick } = picker(0x6a7a)
  for (let n = 0; n < 300; n++) {
    let input = ''
    const length = int(12)
    // Mostly kana, so the random cases are not all rejected at once.
    for (let i = 0; i < length; i++) input += int(4) === 0 ? pick(tokens) : pick(tokens.slice(0, 7))
    cases.push(input)
  }
  return cases
}

const RULE = '-'.repeat(55)

/** A realistic Aozora Bunko text, also used inside the zip cases. */
export const AOZORA_SAMPLE = [
  'タイトル', '著者名', '', RULE, '【テキスト中に現れる記号について】', '', '《》：ルビ', '（例）僕《ぼく》', '',
  '｜：ルビの付く文字列の始まりを特定する記号', '（例）｜二十世紀《にじっせいき》', '',
  '［＃］：入力者注　主に外字の説明や、傍点の位置の指定', '（例）※［＃「にんべん＋并」、第3水準1-14-8］', RULE,
  '　本文が始まる。僕《ぼく》は｜二十世紀《にじっせいき》の話をした。', '「会話文だ。」と彼は言った。［＃改ページ］',
  'それから※［＃「はしごだか」、U+9AD9、12-3］橋君と話した／＼。', '底本：「作品集　第一巻」出版社',
  '　　1950（昭和25）年5月10日発行', '※このファイルは青空文庫で作られました。',
].join('\n')

export function cleanCases(): string[] {
  const cases = [
    AOZORA_SAMPLE, AOZORA_SAMPLE.replaceAll('\n', '\r\n'), '', '\n', 'タイトル\n著者\n\n本文一行目',
    '本文\n底本：「作品集」出版社\n発行日など', '\n本文\n　底本:出典社\n以下略', '\n本文のみ、底本情報なし',
    '\n本文\n続き［＃本文終わり］\n入力者付記など', '\n本文\n続き［＃本文終わり］\n底本：x', '\n本文\n底本：x\n続き［＃本文終わり］',
    '\n本文 底本：x', '\n本文 底本：x', '\n本文 　 \t底本:x', '\n本文\r底本：x', '\nx底本：', '\n底本',
    '\nテキスト［＃割り注］注釈内容［＃割り注終わり］続き', '\nテキスト［＃割り注］（既に括弧）［＃割り注終わり］続き',
    '\na［＃割り注］b', '\n［＃割り注］（［＃割り注終わり］', '\n［＃割り注］）（［＃割り注終わり］',
    '\n［＃割り注］a［＃割り注］b［＃割り注終わり］c［＃割り注終わり］', '\n｜二十世紀《にじっせいき》の話', '\n僕《ぼく》は元気',
    '\na《b｜c', '\n《a《b》c》', '\n※［＃「はしごだか」、U+9AD9、12-3］橋', '\n前※［＃「にんべん＋并」、第3水準1-14-8］後',
    '\n※［＃U+1F600］', '\n※［＃U+12, U+0041F］', '\n※［＃U+D800］x', '\n※［＃U+DC00］', '\n※［＃U+110000］',
    '\n※［＃U+10FFFF］', '\n※［＃u+9AD9］', '\n※［＃U+9AD9F0F］', '\n※［＃U+abcd］', '\n※［＃U+9AD9', '\n※ ［＃U+9AD9］',
    '\nあ／″＼い／＼う', '\n／″／＼＼', '\nA［＃foo［＃bar］baz］B', '\n「会話文だ。」と彼は言った。［＃改ページ］',
    '\n入力［注記ではない］部分', '\n［＃a［b］］', '\n［＃［＃［＃x］］］y', '\n［＃', '\nabc�def',
    '\n\n-----\n本文\n＝＝＝＝\n続き\n\n', '\n - \n=\n―――\n＝-=―\n本文\n 　\n', '\nonly\n﻿\n',
    'OnlyTitleLine', 'title\n\n' + '-'.repeat(29) + '\nx\n' + '-'.repeat(29) + '\ny',
  ]
  // The legend's opening rule just inside and just outside the 30-line
  // window, for title blocks of 0 to 3 lines.
  for (let titleLines = 0; titleLines <= 3; titleLines++) {
    for (let blank = 24; blank <= 30; blank++) {
      const title = Array.from({ length: titleLines }, (_, i) => `title${i}`)
      cases.push([...title, ...Array<string>(blank).fill(''), RULE, 'legend', RULE, 'body'].join('\n'))
    }
  }

  const tokens = [
    '本文', 'あ', '　', ' ', '\t', '《', '》', '｜', '《かな》', '［＃', '］', '［', '［＃割り注］', '［＃割り注終わり］', '（',
    '）', '※［＃', 'U+9AD9', 'U+D800', 'U+1F600', 'U+12', '第3水準1-14-8', '、', '／″＼', '／＼', '／', '＼', '″',
    '底本：', '底本:', '［＃本文終わり］', ' ', ' ', '�', '-', '＝', '=', '―', '-'.repeat(30), '＝＝＝',
    '﻿',
  ]
  const { int, pick } = picker(0xa0c0)
  for (let n = 0; n < 300; n++) {
    const lines: string[] = []
    const lineCount = int(41)
    for (let l = 0; l < lineCount; l++) {
      let line = ''
      const length = int(9)
      for (let i = 0; i < length; i++) line += int(60) === 0 ? 'U+110000' : pick(tokens)
      lines.push(line)
    }
    const breaks = ['\n', '\r\n', '\r']
    cases.push(lines.reduce((text, line, i) => (i === 0 ? line : text + pick(breaks) + line), ''))
  }
  return cases
}
