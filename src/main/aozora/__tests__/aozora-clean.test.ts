// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  normalizeNewlines,
  removeHeader,
  removeFooter,
  resolveWarichu,
  removeRuby,
  resolveGaiji,
  convertRepeatMarks,
  removeAnnotations,
  stripReplacementChar,
  trimEdges,
  cleanAozoraText,
} from '../aozora-clean'

describe('normalizeNewlines', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeNewlines('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  it('converts lone CR to LF', () => {
    expect(normalizeNewlines('a\rb\rc')).toBe('a\nb\nc')
  })
})

describe('removeHeader', () => {
  it('drops the leading title/author block when no legend block is present', () => {
    const input = 'タイトル\n著者\n\n本文一行目'
    expect(removeHeader(input)).toBe('\n本文一行目')
  })

  it('drops the title/author block and the dash-delimited legend block', () => {
    const input = [
      'タイトル',
      '著者名',
      '',
      '------------------------------------------------------------------',
      '【テキスト中に現れる記号について】',
      '（凡例の中身）',
      '------------------------------------------------------------------',
      '本文',
    ].join('\n')
    expect(removeHeader(input)).toBe('\n本文')
  })

  it('still removes the legend block when its opening rule starts within the top 30 lines', () => {
    const filler = Array.from({ length: 20 }, (_, n) => `前書き${n}行目`)
    const input = [
      'タイトル',
      '著者名',
      '',
      ...filler,
      '------------------------------------------------------------------',
      '【テキスト中に現れる記号について】',
      '------------------------------------------------------------------',
      '本文',
    ].join('\n')
    expect(removeHeader(input)).not.toContain('【テキスト中に現れる記号について】')
    expect(removeHeader(input)).toContain('本文')
  })

  it('preserves a dashed-rule pair that occurs deep in the body (past the top-of-file scan window)', () => {
    const filler = Array.from({ length: 40 }, (_, n) => `本文${n}行目`)
    const input = [
      'タイトル',
      '著者名',
      '',
      ...filler,
      '------------------------------------------------------------------',
      '場面転換',
      '------------------------------------------------------------------',
      '続きの本文',
    ].join('\n')
    const result = removeHeader(input)
    expect(result).toContain('場面転換')
    expect(result).toContain('続きの本文')
    expect(result).toContain('本文0行目')
  })
})

describe('removeFooter', () => {
  it('cuts everything from 底本： (fullwidth colon) to the end', () => {
    const input = '本文\n底本：「作品集」出版社\n発行日など'
    expect(removeFooter(input)).toBe('本文\n')
  })

  it('cuts everything from an indented 底本: (halfwidth colon) to the end', () => {
    const input = '本文\n　底本:出典社\n以下略'
    expect(removeFooter(input)).toBe('本文\n')
  })

  it('leaves text untouched when no colophon marker is present', () => {
    const input = '本文のみ、底本情報なし'
    expect(removeFooter(input)).toBe(input)
  })

  it('cuts (and drops) everything from the ［＃本文終わり］ end-of-body marker', () => {
    const input = '本文\n続き［＃本文終わり］\n入力者付記など'
    expect(removeFooter(input)).toBe('本文\n')
  })

  it('when both markers are present, cuts at whichever comes first', () => {
    const bodyMarkerFirst = '本文\n続き［＃本文終わり］\n底本：「作品集」出版社'
    expect(removeFooter(bodyMarkerFirst)).toBe('本文\n')

    const colophonFirst = '本文\n底本：「作品集」出版社\n続き［＃本文終わり］'
    expect(removeFooter(colophonFirst)).toBe('本文\n')
  })
})

describe('resolveWarichu', () => {
  it('wraps inline note content in fullwidth parens', () => {
    const input = 'テキスト［＃割り注］注釈内容［＃割り注終わり］続き'
    expect(resolveWarichu(input)).toBe('テキスト（注釈内容）続き')
  })

  it('does not double-wrap content already in fullwidth parens', () => {
    const input = 'テキスト［＃割り注］（既に括弧）［＃割り注終わり］続き'
    expect(resolveWarichu(input)).toBe('テキスト（既に括弧）続き')
  })
})

describe('removeRuby', () => {
  it('removes 《…》 spans and the leading ｜ ruby-start marker', () => {
    const input = '｜二十世紀《にじっせいき》の話'
    expect(removeRuby(input)).toBe('二十世紀の話')
  })

  it('removes 《…》 spans without a ｜ marker', () => {
    const input = '僕《ぼく》は元気'
    expect(removeRuby(input)).toBe('僕は元気')
  })
})

describe('resolveGaiji', () => {
  it('resolves U+XXXX notation to the corresponding code point', () => {
    const input = '※［＃「はしごだか」、U+9AD9、12-3］橋'
    expect(resolveGaiji(input)).toBe('髙橋')
  })

  it('drops menkuten-only gaiji tokens and keeps the rest of the line', () => {
    const input = '前※［＃「にんべん＋并」、第3水準1-14-8］後'
    expect(resolveGaiji(input)).toBe('前後')
  })
})

describe('convertRepeatMarks', () => {
  it('converts ／″＼ before ／＼ so the three-character mark is not split', () => {
    const input = 'あ／″＼い／＼う'
    expect(convertRepeatMarks(input)).toBe('あ〴〵い〳〵う')
  })
})

describe('removeAnnotations', () => {
  it('removes nested ［＃…］ annotations from the innermost level out', () => {
    const input = 'A［＃foo［＃bar］baz］B'
    expect(removeAnnotations(input)).toBe('AB')
  })

  it('removes a simple ［＃…］ annotation', () => {
    const input = '「会話文だ。」と彼は言った。［＃改ページ］'
    expect(removeAnnotations(input)).toBe('「会話文だ。」と彼は言った。')
  })

  it('leaves plain ［…］ brackets without a ＃ marker untouched', () => {
    const input = '入力［注記ではない］部分'
    expect(removeAnnotations(input)).toBe(input)
  })
})

describe('stripReplacementChar', () => {
  it('removes U+FFFD replacement characters', () => {
    const input = 'abc�def'
    expect(stripReplacementChar(input)).toBe('abcdef')
  })
})

describe('trimEdges', () => {
  it('trims leading/trailing blank lines and drops horizontal-rule-only lines', () => {
    const input = '\n\n-----\n本文\n＝＝＝＝\n続き\n\n'
    expect(trimEdges(input)).toBe('本文\n続き')
  })
})

describe('cleanAozoraText (composite fixture)', () => {
  it('cleans a realistic Aozora Bunko sample end to end', () => {
    const input = [
      'タイトル',
      '著者名',
      '',
      '-------------------------------------------------------',
      '【テキスト中に現れる記号について】',
      '',
      '《》：ルビ',
      '（例）僕《ぼく》',
      '',
      '｜：ルビの付く文字列の始まりを特定する記号',
      '（例）｜二十世紀《にじっせいき》',
      '',
      '［＃］：入力者注　主に外字の説明や、傍点の位置の指定',
      '（例）※［＃「にんべん＋并」、第3水準1-14-8］',
      '-------------------------------------------------------',
      '　本文が始まる。僕《ぼく》は｜二十世紀《にじっせいき》の話をした。',
      '「会話文だ。」と彼は言った。［＃改ページ］',
      'それから※［＃「はしごだか」、U+9AD9、12-3］橋君と話した／＼。',
      '底本：「作品集　第一巻」出版社',
      '　　1950（昭和25）年5月10日発行',
      '※このファイルは青空文庫で作られました。',
    ].join('\n')

    const expected = [
      '　本文が始まる。僕は二十世紀の話をした。',
      '「会話文だ。」と彼は言った。',
      'それから髙橋君と話した〳〵。',
    ].join('\n')

    expect(cleanAozoraText(input)).toBe(expected)
  })

  it('handles CRLF input end to end', () => {
    const input = ['タイトル', '著者', '', '本文《ふりがな》あり'].join('\r\n')
    expect(cleanAozoraText(input)).toBe('本文あり')
  })
})
