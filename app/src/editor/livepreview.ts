// Vista previa en vivo (estilo Obsidian): oculta la sintaxis Markdown fuera
// del cursor y muestra enlaces, casillas, imágenes, reglas y fórmulas.
// Sólo decora los rangos visibles → coste proporcional a la pantalla, no al documento.

import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import katex from 'katex';

export interface LinkContext {
  sourcePath: () => string;
  resolve: (target: string) => string | null;
  resourceUrl: (path: string) => Promise<string>;
  openLink: (href: string, newTab: boolean) => void;
  openTag: (tag: string) => void;
}

const IMAGE = /\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i;
const titleOf = (p: string) => {
  const b = p.slice(p.lastIndexOf('/') + 1);
  return b.toLowerCase().endsWith('.md') ? b.slice(0, -3) : b;
};

export function parseWikiInner(inner: string) {
  const bar = inner.indexOf('|');
  const left = bar >= 0 ? inner.slice(0, bar) : inner;
  const display = bar >= 0 ? inner.slice(bar + 1).trim() : '';
  const hash = left.indexOf('#');
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const sub = hash >= 0 ? left.slice(hash + 1).trim() : '';
  return { target, sub, display };
}

class LinkWidget extends WidgetType {
  constructor(readonly text: string, readonly href: string, readonly unresolved: boolean, readonly ctx: LinkContext, readonly embed: boolean) {
    super();
  }
  eq(o: LinkWidget) {
    return o.text === this.text && o.href === this.href && o.unresolved === this.unresolved && o.embed === this.embed;
  }
  toDOM() {
    const a = document.createElement('span');
    a.className = 'cm-wikilink-rendered' + (this.unresolved ? ' is-unresolved' : '') + (this.embed ? ' is-embed' : '');
    a.textContent = (this.embed ? '⧉ ' : '') + this.text;
    a.title = this.href;
    a.addEventListener('mousedown', (e) => {
      if (e.button > 1) return;
      e.preventDefault();
      e.stopPropagation();
      this.ctx.openLink(this.href, e.ctrlKey || e.metaKey || e.button === 1);
    });
    return a;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly path: string, readonly alt: string, readonly ctx: LinkContext) {
    super();
  }
  eq(o: ImageWidget) {
    return o.path === this.path && o.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-image-embed';
    const img = document.createElement('img');
    img.alt = this.alt;
    const m = /^(\d+)(?:x(\d+))?$/.exec(this.alt);
    if (m) {
      img.style.width = m[1] + 'px';
      if (m[2]) img.style.height = m[2] + 'px';
    }
    if (/^(https?:|data:)/.test(this.path)) img.src = this.path;
    else void this.ctx.resourceUrl(this.path).then((u) => (img.src = u));
    wrap.append(img);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-task-checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.checked;
    cb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    wrap.append(cb);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-hr-widget';
    return s;
  }
}

class MathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-math-rendered';
    s.innerHTML = katex.renderToString(this.tex, { throwOnError: false });
    return s;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const hr = Decoration.replace({ widget: new HrWidget() });

function frontmatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text !== '---') return -1;
  for (let i = 2; i <= Math.min(doc.lines, 500); i++) {
    const t = doc.line(i).text.trimEnd();
    if (t === '---' || t === '...') return doc.line(i).to;
  }
  return -1;
}

function build(view: EditorView, ctx: LinkContext, live: boolean): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const touches = (from: number, to: number) => view.hasFocus && sel.some((r) => r.from <= to && r.to >= from);
  const lineTouched = (pos: number) => {
    const l = state.doc.lineAt(pos);
    return touches(l.from, l.to);
  };
  const fmEnd = frontmatterEnd(state);
  const lineClass = (pos: number, cls: string) => decos.push(Decoration.line({ class: cls }).range(state.doc.lineAt(pos).from));

  for (const { from, to } of view.visibleRanges) {
    if (fmEnd > 0 && from <= fmEnd) {
      for (let p = Math.max(from, 0); p <= Math.min(fmEnd, to); ) {
        const l = state.doc.lineAt(p);
        lineClass(l.from, 'cm-frontmatter');
        p = l.to + 1;
      }
    }
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (fmEnd > 0 && node.to <= fmEnd) return false;

        if (name.startsWith('ATXHeading')) {
          const lvl = name.slice(10);
          lineClass(node.from, `cm-heading-line cm-h${lvl}`);
          if (live && !lineTouched(node.from)) {
            const mark = node.node.firstChild;
            if (mark?.name === 'HeaderMark') {
              const end = Math.min(mark.to + 1, node.to);
              decos.push(hide.range(mark.from, end));
            }
          }
          return;
        }
        switch (name) {
          case 'FencedCode': {
            for (let p = node.from; p <= node.to; ) {
              const l = state.doc.lineAt(p);
              const isFence = l.from === node.from || l.to === node.to;
              lineClass(l.from, isFence ? 'cm-codeblock cm-codeblock-fence' : 'cm-codeblock');
              p = l.to + 1;
            }
            return false;
          }
          case 'Blockquote': {
            const firstLine = state.doc.lineAt(node.from);
            const callout = /^>\s*\[!([\w-]+)\]/.exec(firstLine.text);
            for (let p = node.from; p <= node.to; ) {
              const l = state.doc.lineAt(p);
              lineClass(l.from, callout ? `cm-blockquote cm-callout-line${l.from === firstLine.from ? ' cm-callout-title' : ''}` : 'cm-blockquote');
              if (callout) decos.push(Decoration.line({ attributes: { 'data-callout': callout[1].toLowerCase() } }).range(l.from));
              p = l.to + 1;
            }
            return;
          }
          case 'QuoteMark':
            if (live && !lineTouched(node.from)) {
              const next = state.doc.sliceString(node.to, node.to + 1);
              decos.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
            }
            return;
          case 'HorizontalRule':
            if (live && !lineTouched(node.from)) decos.push(hr.range(node.from, node.to));
            return;
          case 'ListMark': {
            if (!live || lineTouched(node.from)) return;
            const sib = node.node.nextSibling;
            const text = state.doc.sliceString(node.from, node.to);
            if (sib?.name === 'Task') {
              decos.push(hide.range(node.from, Math.min(node.to + 1, sib.from)));
            } else if (text === '-' || text === '*' || text === '+') {
              decos.push(bullet.range(node.from, node.to));
            }
            return;
          }
          case 'TaskMarker': {
            if (!live || lineTouched(node.from)) return;
            const txt = state.doc.sliceString(node.from, node.to);
            decos.push(Decoration.replace({ widget: new CheckboxWidget(txt[1] !== ' ', node.from) }).range(node.from, node.to));
            if (txt[1] !== ' ') {
              const l = state.doc.lineAt(node.from);
              if (node.to + 1 < l.to) decos.push(Decoration.mark({ class: 'cm-task-done' }).range(node.to + 1, l.to));
            }
            return;
          }
          case 'Emphasis':
          case 'StrongEmphasis':
          case 'Strikethrough':
          case 'InlineCode':
          case 'Highlight': {
            if (!live || touches(node.from, node.to)) return;
            const c = node.node.cursor();
            if (c.firstChild()) {
              do {
                if (/Mark$/.test(c.name) && c.name !== 'ListMark') decos.push(hide.range(c.from, c.to));
              } while (c.nextSibling());
            }
            return;
          }
          case 'Comment':
            if (live && !touches(node.from, node.to)) decos.push(Decoration.mark({ class: 'cm-comment-hidden' }).range(node.from, node.to));
            return false;
          case 'InlineMath':
            if (live && !touches(node.from, node.to)) {
              const tex = state.doc.sliceString(node.from + 1, node.to - 1);
              decos.push(Decoration.replace({ widget: new MathWidget(tex) }).range(node.from, node.to));
            }
            return false;
          case 'Hashtag': {
            const tag = state.doc.sliceString(node.from + 1, node.to);
            decos.push(Decoration.mark({ class: 'cm-hashtag-rendered', attributes: { 'data-tag': tag } }).range(node.from, node.to));
            return false;
          }
          case 'WikiLink': {
            if (!live || touches(node.from, node.to)) return false;
            const raw = state.doc.sliceString(node.from, node.to);
            const embed = raw.startsWith('!');
            const { target, sub, display } = parseWikiInner(raw.slice(embed ? 3 : 2, -2));
            const resolved = target ? ctx.resolve(target) : ctx.sourcePath();
            if (embed && resolved && IMAGE.test(resolved)) {
              decos.push(Decoration.replace({ widget: new ImageWidget(resolved, display, ctx) }).range(node.from, node.to));
              return false;
            }
            const text = display || (target ? titleOf(target) : '') + (sub ? (target ? ' › ' : '') + sub.replace(/^\^/, '') : '');
            const href = target + (sub ? '#' + sub : '');
            decos.push(Decoration.replace({ widget: new LinkWidget(text, href, !resolved, ctx, embed) }).range(node.from, node.to));
            return false;
          }
          case 'Image': {
            if (!live || touches(node.from, node.to)) return false;
            const raw = state.doc.sliceString(node.from, node.to);
            const m = /^!\[([^\]]*)]\(<?([^)\s>]+)>?/.exec(raw);
            if (!m) return false;
            let src = m[2];
            try {
              src = decodeURIComponent(src);
            } catch {
              /* tal cual */
            }
            const isUrl = /^(https?:|data:)/.test(src);
            const resolved = isUrl ? src : ctx.resolve(src);
            if (resolved) decos.push(Decoration.replace({ widget: new ImageWidget(resolved, m[1], ctx) }).range(node.from, node.to));
            return false;
          }
          case 'Link': {
            if (!live || touches(node.from, node.to)) return false;
            const marks: { from: number; to: number }[] = [];
            let url = '';
            const c = node.node.cursor();
            if (c.firstChild()) {
              do {
                if (c.name === 'LinkMark') marks.push({ from: c.from, to: c.to });
                if (c.name === 'URL') url = state.doc.sliceString(c.from, c.to);
              } while (c.nextSibling());
            }
            if (marks.length < 2 || !url) return false;
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            if (textTo <= textFrom) return false;
            const external = /^[a-z][a-z0-9+.-]*:/i.test(url);
            let dec = url;
            try {
              dec = decodeURIComponent(url);
            } catch {
              /* tal cual */
            }
            const unresolved = !external && !ctx.resolve(dec.split('#')[0]);
            decos.push(hide.range(node.from, textFrom));
            decos.push(
              Decoration.mark({
                class: `cm-link-rendered${external ? ' is-external' : ''}${unresolved ? ' is-unresolved' : ''}`,
                attributes: { 'data-href': dec, title: url },
              }).range(textFrom, textTo),
            );
            decos.push(hide.range(textTo, node.to));
            return false;
          }
        }
        return;
      },
    });
  }
  return Decoration.set(decos, true);
}

export function livePreview(ctx: LinkContext, live: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, ctx, live);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view, ctx, live);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const t = e.target as HTMLElement;
          const link = t.closest<HTMLElement>('.cm-link-rendered');
          if (link && (live || e.ctrlKey || e.metaKey)) {
            const href = link.dataset.href ?? '';
            e.preventDefault();
            if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href, '_blank', 'noopener');
            else ctx.openLink(href, e.ctrlKey || e.metaKey);
            return true;
          }
          const tag = t.closest<HTMLElement>('.cm-hashtag-rendered');
          if (tag && (e.ctrlKey || e.metaKey || (live && !view.hasFocus))) {
            e.preventDefault();
            ctx.openTag(tag.dataset.tag ?? '');
            return true;
          }
          // Mod+clic sobre [[enlace]] en modo fuente.
          if (e.ctrlKey || e.metaKey) {
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            let n = syntaxTree(view.state).resolveInner(pos, 1);
            while (n.parent && n.name !== 'WikiLink') n = n.parent;
            if (n.name === 'WikiLink') {
              const raw = view.state.doc.sliceString(n.from, n.to);
              const { target, sub } = parseWikiInner(raw.slice(raw.startsWith('!') ? 3 : 2, -2));
              e.preventDefault();
              ctx.openLink(target + (sub ? '#' + sub : ''), true);
              return true;
            }
          }
          return false;
        },
      },
    },
  );
}
