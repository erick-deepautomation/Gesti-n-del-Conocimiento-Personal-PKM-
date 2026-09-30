// Extensiones de sintaxis Lezer para Markdown estilo Obsidian.
import type { MarkdownConfig, InlineContext } from '@lezer/markdown';
import { Tag, tags as t } from '@lezer/highlight';
import { HighlightStyle } from '@codemirror/language';

export const obsidianTags = {
  wikilink: Tag.define(t.link),
  hashtag: Tag.define(),
  highlight: Tag.define(),
  comment: Tag.define(t.comment),
  math: Tag.define(),
};

const TAG_RE = /^[\p{L}\p{N}_\-/]+/u;

function prevOk(cx: InlineContext, pos: number) {
  const c = cx.char(pos - 1);
  return c === -1 || c === 32 || c === 9 || c === 10 || c === 40 || c === 44 || c === 91 || c === 42 || c === 95;
}

export const obsidianMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: obsidianTags.wikilink },
    { name: 'WikiLinkMark', style: t.processingInstruction },
    { name: 'Hashtag', style: obsidianTags.hashtag },
    { name: 'Highlight', style: obsidianTags.highlight },
    { name: 'HighlightMark', style: t.processingInstruction },
    { name: 'Comment', style: obsidianTags.comment },
    { name: 'InlineMath', style: obsidianTags.math },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        let open = pos;
        if (next === 33) {
          if (cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
          open = pos + 1;
        } else if (next !== 91 || cx.char(pos + 1) !== 91) return -1;
        for (let i = open + 2; i < cx.end - 1; i++) {
          const c = cx.char(i);
          if (c === 10) return -1;
          if (c === 91 && cx.char(i + 1) === 91) return -1;
          if (c === 93 && cx.char(i + 1) === 93) {
            if (i === open + 2) return -1;
            return cx.addElement(
              cx.elt('WikiLink', pos, i + 2, [cx.elt('WikiLinkMark', pos, open + 2), cx.elt('WikiLinkMark', i, i + 2)]),
            );
          }
        }
        return -1;
      },
    },
    {
      name: 'Comment',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
        const rest = cx.slice(pos + 2, cx.end);
        const end = rest.indexOf('%%');
        if (end < 0) return -1;
        return cx.addElement(cx.elt('Comment', pos, pos + 2 + end + 2));
      },
    },
    {
      name: 'InlineMath',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const n = cx.char(pos + 1);
        if (n === 36 || n === 32 || n === -1) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10) return -1;
          if (c === 36 && cx.char(i - 1) !== 92) {
            if (cx.char(i - 1) === 32) return -1;
            const after = cx.char(i + 1);
            if (after >= 48 && after <= 57) return -1;
            return cx.addElement(cx.elt('InlineMath', pos, i + 1));
          }
        }
        return -1;
      },
    },
    {
      name: 'Hashtag',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 35 || !prevOk(cx, pos)) return -1;
        const m = TAG_RE.exec(cx.slice(pos + 1, Math.min(cx.end, pos + 200)));
        if (!m) return -1;
        const tag = m[0].replace(/\/+$/, '');
        if (!tag || /^\d+$/.test(tag)) return -1;
        return cx.addElement(cx.elt('Hashtag', pos, pos + 1 + tag.length));
      },
    },
    {
      name: 'Highlight',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 32) return -1;
        const rest = cx.slice(pos + 2, cx.end);
        const end = rest.indexOf('==');
        if (end <= 0 || rest.slice(0, end).includes('\n')) return -1;
        const e = pos + 2 + end + 2;
        return cx.addElement(cx.elt('Highlight', pos, e, [cx.elt('HighlightMark', pos, pos + 2), cx.elt('HighlightMark', e - 2, e)]));
      },
    },
  ],
};

export const obsidianHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-header-1' },
  { tag: t.heading2, class: 'cm-header-2' },
  { tag: t.heading3, class: 'cm-header-3' },
  { tag: t.heading4, class: 'cm-header-4' },
  { tag: t.heading5, class: 'cm-header-5' },
  { tag: t.heading6, class: 'cm-header-6' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.url, class: 'cm-url' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: t.processingInstruction, class: 'cm-formatting' },
  { tag: t.contentSeparator, class: 'cm-hr' },
  { tag: t.list, class: 'cm-list' },
  { tag: obsidianTags.wikilink, class: 'cm-wikilink' },
  { tag: obsidianTags.hashtag, class: 'cm-hashtag' },
  { tag: obsidianTags.highlight, class: 'cm-highlight' },
  { tag: obsidianTags.comment, class: 'cm-comment' },
  { tag: obsidianTags.math, class: 'cm-math' },
  // Código dentro de bloques
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: [t.string, t.special(t.string)], class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: [t.number, t.bool, t.null], class: 'tok-number' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-function' },
  { tag: [t.typeName, t.className], class: 'tok-type' },
  { tag: [t.propertyName, t.attributeName], class: 'tok-property' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.operator, class: 'tok-operator' },
]);
