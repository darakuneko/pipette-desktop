#!/usr/bin/env node
/**
 * docs/build-guide.mjs
 * Converts OPERATION-GUIDE.md, OPERATION-GUIDE.ja.md, and Data.md
 * into a single docs/guide.html with a left-sidebar TOC layout.
 *
 * Usage: node docs/build-guide.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Utilities ────────────────────────────────────────────────────────────────

const esc = s =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function slugify(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w぀-鿿\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Maps filename patterns in markdown links to their doc tab id
const XDOC_LINK_PATTERNS = [
  [/\[([^\]]+)\]\(OPERATION-GUIDE\.md(#[^)]*)?\)/g,    'en'],
  [/\[([^\]]+)\]\(OPERATION-GUIDE\.ja\.md(#[^)]*)?\)/g, 'ja'],
  [/\[([^\]]+)\]\(Data\.md(#[^)]*)?\)/g,               'data'],
  [/\[([^\]]+)\]\(THEME-PACK-AUTHORING\.html[^)]*\)/g,  'theme'],
];

// ─── Markdown → HTML ─────────────────────────────────────────────────────────

function convertMd(md, docId) {
  const codeBlocks  = [];
  const inlineCodes = [];

  // 0. Strip embedded TOC sections — sidebar replaces them
  md = md.replace(/^## (Table of Contents|目次)\n[\s\S]*?(?=^## )/m, '');

  // 1. Extract fenced code blocks (protect from further processing)
  md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
    const i = codeBlocks.length;
    codeBlocks.push(
      `<pre class="code-block"><code>${esc(body.trimEnd())}</code></pre>`
    );
    return `\x00CB${i}\x00`;
  });

  // 2. Extract inline code
  md = md.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlineCodes.length;
    inlineCodes.push(`<code class="ic">${esc(code)}</code>`);
    return `\x00IC${i}\x00`;
  });

  function inline(s) {
    // Images
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
      (_, alt, src) => `<img src="${src}" alt="${esc(alt)}" class="doc-img" loading="lazy">`);
    // Cross-doc links (filename → tab id, optional hash)
    for (const [pat, docTarget] of XDOC_LINK_PATTERNS) {
      s = s.replace(pat, (_, t, h = '') => `<a href="#" class="xdoc" data-doc="${docTarget}" data-hash="${h}">${t}</a>`);
    }
    // Other .html links
    s = s.replace(/\[([^\]]+)\]\(([^)]+\.html[^)]*)\)/g,
      (_, t, href) => `<a href="${href}" target="_blank">${t}</a>`);
    // External links
    s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,
      (_, t, href) => `<a href="${href}" target="_blank" rel="noopener">${t}</a>`);
    // Internal anchor links (#section)
    s = s.replace(/\[([^\]]+)\]\(#([^)]+)\)/g,
      (_, t, anchor) => `<a href="#" class="ilink" data-doc="${docId}" data-hash="#${anchor}">${t}</a>`);
    // Remaining links (relative paths like ../sample-packs/...)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
    // Bold (process before italic)
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return s;
  }

  const lines = md.split('\n');
  const parts = [];
  let i = 0;

  const isBlockStart = l =>
    !l.trim() || l.match(/^#{1,6} /) || l.startsWith('|') || l.startsWith('>') ||
    /^[ \t]*[-*] /.test(l) || /^\d+\. /.test(l) || /^-{3,}$/.test(l) ||
    l.match(/^\x00CB\d+\x00/);

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (!line.trim()) { i++; continue; }

    // Code block placeholder (on its own line)
    const cbm = line.match(/^\x00CB(\d+)\x00$/);
    if (cbm) {
      parts.push(codeBlocks[+cbm[1]]);
      i++; continue;
    }

    // Heading
    const hm = line.match(/^(#{1,6}) (.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      const rawText = hm[2];
      const cleanText = rawText.replace(/\x00IC\d+\x00/g, '').replace(/\*+/g, '');
      const id = slugify(cleanText);
      parts.push(`<h${lvl} id="${id}">${inline(rawText)}</h${lvl}>`);
      i++; continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
      parts.push('<hr>');
      i++; continue;
    }

    // Table (current line starts with | and next line is separator)
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[-: |]+\|$/.test(lines[i + 1])) {
      const tLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tLines.push(lines[i]);
        i++;
      }
      parts.push(buildTable(tLines, inline));
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const bqLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.startsWith('>')) {
          bqLines.push(l.replace(/^> ?/, ''));
          i++;
        } else if (l.trim() === '' && i + 1 < lines.length && lines[i + 1].startsWith('>')) {
          bqLines.push('');
          i++;
        } else {
          break;
        }
      }
      parts.push(`<blockquote>${convertMd(bqLines.join('\n'), docId)}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[ \t]*[-*] /.test(line)) {
      const listLines = [];
      while (i < lines.length) {
        const l = lines[i];
        if (/^[ \t]*[-*] /.test(l)) {
          listLines.push(l);
          i++;
        } else if (l.trim() === '' && i + 1 < lines.length && /^[ \t]*[-*] /.test(lines[i + 1])) {
          i++; // blank line between list items
        } else {
          break;
        }
      }
      parts.push(buildUl(listLines, inline));
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const listLines = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      const items = listLines.map(l =>
        `<li>${inline(l.replace(/^\d+\. /, ''))}</li>`
      );
      parts.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph (everything else)
    const pLines = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      pLines.push(lines[i]);
      i++;
    }
    if (pLines.length > 0) {
      const text = pLines.join(' ');
      const processedText = inline(text);
      // If paragraph contains only images, wrap differently
      const isImageOnly = /^(\s*<img[^>]+>\s*)+$/.test(processedText);
      if (isImageOnly) {
        parts.push(`<div class="img-wrap">${processedText}</div>`);
      } else {
        parts.push(`<p>${processedText}</p>`);
      }
    }
  }

  let html = parts.join('\n');

  // Restore inline code placeholders in a single O(n) pass
  html = html.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[+i]);

  return html;
}

function buildTable(lines, inline) {
  const rows = lines.map(l => l.split('|').slice(1, -1).map(c => c.trim()));
  const header   = rows[0];
  const alignRow = rows[1];
  const body     = rows.slice(2);

  const aligns = alignRow.map(c => {
    if (/^:-+:$/.test(c)) return 'center';
    if (/-+:$/.test(c))   return 'right';
    return 'left';
  });

  const ths = header.map((c, i) =>
    `<th style="text-align:${aligns[i] || 'left'}">${inline(c)}</th>`
  ).join('');

  const trs = body.map(row =>
    '<tr>' +
    row.map((c, i) =>
      `<td style="text-align:${aligns[i] || 'left'}">${inline(c)}</td>`
    ).join('') +
    '</tr>'
  ).join('');

  return `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function buildUl(lines, inline) {
  const getIndent  = l => (l.match(/^(\s*)/) || ['', ''])[1].length;
  const getContent = l => inline(l.replace(/^\s*[-*] /, ''));

  function build(idx, minIndent) {
    const items = [];
    let j = idx;
    while (j < lines.length && getIndent(lines[j]) >= minIndent) {
      if (getIndent(lines[j]) === minIndent && /^[ \t]*[-*] /.test(lines[j])) {
        const content = getContent(lines[j]);
        j++;
        if (j < lines.length && /^[ \t]*[-*] /.test(lines[j]) && getIndent(lines[j]) > minIndent) {
          const [subHtml, nextJ] = build(j, getIndent(lines[j]));
          items.push(`<li>${content}${subHtml}</li>`);
          j = nextJ;
        } else {
          items.push(`<li>${content}</li>`);
        }
      } else {
        j++;
      }
    }
    return [`<ul>${items.join('')}</ul>`, j];
  }

  const [html] = build(0, getIndent(lines[0]));
  return html;
}

// ─── HTML Doc Loader (for pre-authored HTML files) ───────────────────────────

function loadHtmlDoc(filePath) {
  const src = readFileSync(filePath, 'utf-8');

  // Extract <style> block, stripping rules that conflict with guide layout
  let css = '';
  const styleMatch = src.match(/<style>([\s\S]*?)<\/style>/);
  if (styleMatch) {
    css = styleMatch[1]
      .replace(/\*\s*\{[^}]+\}/g, '')   // * reset — already in guide
      .replace(/\bbody\s*\{[^}]+\}/g, ''); // body rule — breaks guide layout
  }

  // Extract <body> content
  const bodyMatch = src.match(/<body>([\s\S]*?)<\/body>/);
  let body = bodyMatch ? bodyMatch[1].trim() : '';

  // Strip <small> subtitle from h1 when embedded (guide header already shows app name)
  body = body.replace(/<h1>([^<]+)<small>[^<]*<\/small><\/h1>/, '<h1>$1</h1>').trimEnd();

  // Add IDs to h2/h3/h4 headings so the TOC can link to them
  body = body.replace(/<h([2-4])>([^<]+)<\/h[2-4]>/g, (_, lvl, text) =>
    `<h${lvl} id="${slugify(text)}">${text}</h${lvl}>`
  );

  return { css, body };
}

// ─── TOC Builder ─────────────────────────────────────────────────────────────

function buildToc(html, docId) {
  // Only h2 and h3 in the sidebar TOC (h4+ would be too long)
  const re = /<h([23]) id="([^"]+)">(.*?)<\/h[23]>/g;
  const items = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({
      level: +m[1],
      id:    m[2],
      text:  m[3].replace(/<[^>]+>/g, ''),
    });
  }

  const liItems = items.map(({ level, id, text }) =>
    `<li class="tl${level}"><a href="#" class="ilink" data-doc="${docId}" data-hash="#${id}">${esc(text)}</a></li>`
  ).join('');

  return `<ul class="toc">${liItems}</ul>`;
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg:          #f5f6f8;
  --sidebar-bg:  #f0f2f7;
  --border:      #d8dce6;
  --text:        #1a1d27;
  --text2:       #5c6478;
  --text3:       #8b94a8;
  --accent:      #2563eb;
  --accent-bg:   #eff4ff;
  --code-bg:     #f0f2f7;
  --header-bg:   #1e2128;
  --header-text: #e8eaf0;
  --sidebar-w:   268px;
  --header-h:    48px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.7;
  font-size: 14px;
}

/* ── Header ── */
header {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: var(--header-h);
  background: var(--header-bg);
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 20px;
  z-index: 200;
  box-shadow: 0 1px 0 rgba(255,255,255,0.06);
}

.logo {
  font-size: 15px;
  font-weight: 700;
  color: var(--header-text);
  letter-spacing: -0.3px;
  white-space: nowrap;
}

.tabs { display: flex; gap: 2px; }

.tab {
  background: transparent;
  border: none;
  color: rgba(232,234,240,0.55);
  font-size: 13px;
  font-weight: 500;
  padding: 5px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.tab:hover { background: rgba(255,255,255,0.1); color: var(--header-text); }
.tab.active { background: var(--accent); color: #fff; }

/* ── Layout ── */
.layout {
  display: flex;
  padding-top: var(--header-h);
  height: 100vh;
}

/* ── Sidebar ── */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  overflow-y: auto;
  height: calc(100vh - var(--header-h));
  position: sticky;
  top: var(--header-h);
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  padding: 16px 0 40px;
}

.sidebar::-webkit-scrollbar { width: 4px; }
.sidebar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.toc-panel { display: none; }
.toc-panel.active { display: block; }

.toc { list-style: none; }

.toc a {
  display: block;
  padding: 3px 14px;
  font-size: 12.5px;
  color: var(--text2);
  text-decoration: none;
  line-height: 1.45;
  border-left: 2px solid transparent;
  transition: color 0.1s, background 0.1s, border-color 0.1s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toc a:hover { color: var(--accent); background: rgba(37,99,235,0.05); }
.toc a.active {
  color: var(--accent);
  border-left-color: var(--accent);
  background: var(--accent-bg);
  font-weight: 600;
}

.toc .tl2 a { padding-left: 14px; font-weight: 600; font-size: 12px; margin-top: 2px; }
.toc .tl3 a { padding-left: 26px; font-size: 12px; }
.toc .tl4 a { padding-left: 38px; font-size: 11.5px; color: var(--text3); }

/* ── Content ── */
.content {
  flex: 1;
  overflow-y: auto;
  padding: 40px 56px 80px;
}

.content::-webkit-scrollbar { width: 6px; }
.content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.doc { display: none; max-width: 860px; }
.doc.active { display: block; }

/* ── Typography ── */
.doc h1 {
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.5px;
  margin-bottom: 6px;
}

.doc h2 {
  font-size: 19px;
  font-weight: 700;
  color: var(--accent);
  border-bottom: 2px solid var(--accent);
  padding-bottom: 6px;
  margin: 40px 0 16px;
  scroll-margin-top: calc(var(--header-h) + 16px);
}

.doc h3 {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  margin: 28px 0 10px;
  scroll-margin-top: calc(var(--header-h) + 16px);
}

.doc h4 {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text2);
  margin: 20px 0 8px;
  scroll-margin-top: calc(var(--header-h) + 16px);
}

.doc h5, .doc h6 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text3);
  margin: 16px 0 6px;
  scroll-margin-top: calc(var(--header-h) + 16px);
}

.doc p {
  color: var(--text2);
  margin-bottom: 12px;
}

.doc hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 32px 0;
}

.doc a { color: var(--accent); text-decoration: none; }
.doc a:hover { text-decoration: underline; }

.doc strong { color: var(--text); font-weight: 600; }
.doc em { font-style: italic; }

/* ── Code ── */
.ic {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  background: var(--code-bg);
  color: #c7254e;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.code-block {
  background: #1e2128;
  color: #abb2bf;
  border-radius: 8px;
  padding: 16px 20px;
  overflow-x: auto;
  margin: 14px 0;
  font-size: 12.5px;
  line-height: 1.6;
}

.code-block code {
  font-family: "SF Mono", "Fira Code", "Consolas", monospace;
  white-space: pre;
}

/* ── Images ── */
.doc-img {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  display: block;
}

.img-wrap {
  margin: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Tables ── */
.table-wrap {
  overflow-x: auto;
  margin: 14px 0;
  border-radius: 8px;
  border: 1px solid var(--border);
}

.table-wrap table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  min-width: 320px;
}

.table-wrap thead th {
  background: var(--code-bg);
  color: var(--accent);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 9px 14px;
  border-bottom: 2px solid var(--border);
  white-space: nowrap;
  font-weight: 700;
}

.table-wrap tbody td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text2);
  vertical-align: top;
  line-height: 1.5;
}

.table-wrap tbody tr:last-child td { border-bottom: none; }
.table-wrap tbody tr:hover td { background: #f9fafb; }

/* ── Lists ── */
.doc ul, .doc ol {
  padding-left: 22px;
  margin: 6px 0 14px;
  color: var(--text2);
}
.doc li { margin-bottom: 3px; line-height: 1.6; }
.doc ul ul, .doc ol ul, .doc ul ol { margin: 3px 0; }

/* ── Blockquote ── */
.doc blockquote {
  border-left: 3px solid var(--accent);
  background: var(--accent-bg);
  padding: 10px 16px;
  border-radius: 0 8px 8px 0;
  margin: 14px 0;
}
.doc blockquote p { margin-bottom: 4px; color: var(--text2); }
.doc blockquote p:last-child { margin-bottom: 0; }
`;

// ─── JavaScript ───────────────────────────────────────────────────────────────

const JS = `
const contentEl = document.querySelector('.content');
const tabs      = [...document.querySelectorAll('.tab')];
const docEls    = [...document.querySelectorAll('.doc')];
const tocPanels = [...document.querySelectorAll('.toc-panel')];

function switchDoc(id, hash) {
  const tabId = DOC_TO_TAB[id] ?? id;
  tabs.forEach(t => t.classList.toggle('active', t.dataset.doc === tabId));
  docEls.forEach(d => d.classList.toggle('active', d.id === 'doc-' + id));
  tocPanels.forEach(p => p.classList.toggle('active', p.id === 'toc-' + id));

  history.replaceState(null, '', '#' + tabId);

  if (hash) {
    setTimeout(() => scrollToHash(id, hash), 60);
  } else {
    contentEl.scrollTop = 0;
  }
}

function scrollToHash(docId, hash) {
  // Use getElementById to avoid CSS selector restriction on numeric-starting IDs (e.g. #1-3-data)
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  const target = document.getElementById(id);
  if (!target) return;
  const offset = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 48;
  const top = target.getBoundingClientRect().top + contentEl.scrollTop - offset - 16;
  contentEl.scrollTo({ top, behavior: 'smooth' });
}

// Tab click
tabs.forEach(tab => tab.addEventListener('click', () => switchDoc(tab.dataset.doc)));

// Link click delegation
document.addEventListener('click', e => {
  const xdoc = e.target.closest('.xdoc');
  if (xdoc) {
    e.preventDefault();
    switchDoc(xdoc.dataset.doc, xdoc.dataset.hash || null);
    return;
  }
  const ilink = e.target.closest('.ilink');
  if (ilink) {
    e.preventDefault();
    const docId = ilink.dataset.doc;
    const hash  = ilink.dataset.hash;
    const activeDoc = document.querySelector('.doc.active');
    if (!activeDoc || activeDoc.id !== 'doc-' + docId) {
      switchDoc(docId, hash || null);
    } else if (hash) {
      scrollToHash(docId, hash);
    }
  }
});

// Highlight active TOC link via IntersectionObserver
function highlightToc(docId, headingId) {
  const toc = document.getElementById('toc-' + docId);
  if (!toc) return;
  let found = null;
  toc.querySelectorAll('a').forEach(a => {
    const active = a.dataset.hash === '#' + headingId;
    a.classList.toggle('active', active);
    if (active) found = a;
  });
  // scroll the TOC sidebar to keep active item visible
  if (found) {
    const sidebar = document.querySelector('.sidebar');
    const aTop  = found.getBoundingClientRect().top;
    const { top: sTop, bottom: sBot } = sidebar.getBoundingClientRect();
    if (aTop < sTop + 40 || aTop > sBot - 40) {
      found.scrollIntoView({ block: 'nearest' });
    }
  }
}

// Activate tab from URL hash on load (e.g. guide.html#data)
const initTabId = location.hash.slice(1);
if (initTabId && tabs.some(t => t.dataset.doc === initTabId)) {
  switchDoc(initTabId);
}

docEls.forEach(docEl => {
  const docId    = docEl.id.replace('doc-', '');
  const headings = docEl.querySelectorAll('h2, h3');

  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(e => e.isIntersecting);
    if (visible.length > 0) {
      highlightToc(docId, visible[0].target.id);
    }
  }, {
    root:       contentEl,
    rootMargin: '-10% 0px -75% 0px',
    threshold:  0,
  });

  headings.forEach(h => observer.observe(h));
});
`;

// ─── Document definitions ─────────────────────────────────────────────────────

const DOCS = [
  { id: 'en',    label: 'Operation Guide', file: 'OPERATION-GUIDE.md',          lang: 'en' },
  { id: 'ja',    label: '操作ガイド',       file: 'OPERATION-GUIDE.ja.md',        lang: 'ja', tab: 'en' },
  { id: 'data',  label: 'Data Guide',       file: 'Data.md',                     lang: 'en' },
  { id: 'theme', label: 'Theme Authoring',  file: 'THEME-PACK-AUTHORING.html',   lang: 'en', html: true },
];

// Tab bar only shows docs without a `tab` property (JA is accessed via in-doc links)
const TAB_DOCS = DOCS.filter(d => !d.tab);

// Map each doc id to the tab that owns it
const DOC_TO_TAB = Object.fromEntries(DOCS.map(d => [d.id, d.tab ?? d.id]));

// ─── Render ───────────────────────────────────────────────────────────────────

const rendered = {};
const tocs     = {};
let   extraCss = '';

for (const doc of DOCS) {
  process.stdout.write(`  converting ${doc.file} … `);
  if (doc.html) {
    const { css, body } = loadHtmlDoc(join(__dir, doc.file));
    extraCss        += css;
    rendered[doc.id] = body;
  } else {
    const md = readFileSync(join(__dir, doc.file), 'utf-8');
    rendered[doc.id] = convertMd(md, doc.id);
  }
  tocs[doc.id] = buildToc(rendered[doc.id], doc.id);
  process.stdout.write('done\n');
}

const active = (i) => i === 0 ? ' active' : '';

const tabButtons = TAB_DOCS.map((d, i) =>
  `<button class="tab${active(i)}" data-doc="${d.id}">${esc(d.label)}</button>`
).join('\n    ');

const tocPanelHtml = DOCS.map((d, i) =>
  `<div id="toc-${d.id}" class="toc-panel${active(i)}">\n${tocs[d.id]}\n</div>`
).join('\n    ');

const docPanelHtml = DOCS.map((d, i) =>
  `<article id="doc-${d.id}" class="doc${active(i)}" lang="${d.lang}">\n${rendered[d.id]}\n</article>`
).join('\n    ');

const output = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pipette — Documentation</title>
<style>${CSS}${extraCss}</style>
</head>
<body>

<header>
  <span class="logo">Pipette Docs</span>
  <nav class="tabs">
    ${tabButtons}
  </nav>
</header>

<div class="layout">
  <aside class="sidebar">
    ${tocPanelHtml}
  </aside>
  <main class="content">
    ${docPanelHtml}
  </main>
</div>

<script>const DOC_TO_TAB=${JSON.stringify(DOC_TO_TAB)};${JS}</script>
</body>
</html>
`;

const outPath = join(__dir, 'guide.html');
writeFileSync(outPath, output);
console.log(`\n✓  docs/guide.html  (${Math.round(output.length / 1024)} KB)`);
