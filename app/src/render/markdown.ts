// Renderizado de Markdown con sabor Obsidian: [[wikilinks]], ![[incrustaciones]],
// #etiquetas, ==resaltado==, %%comentarios%%, callouts, tareas, ^bloques,
// notas al pie, KaTeX, Mermaid y resaltado de código.

import MarkdownIt from 'markdown-it';
import type { StateBlock, StateInline } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { App } from '../core/app';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, escapeHtml, extname, fold, h, icon, titleOf } from '../core/util';

// ------------------------------------------------------------------ reglas markdown-it

function splitInner(inner: string) {
  let [left, display] = inner.includes('|') ? [inner.slice(0, inner.indexOf('|')), inner.slice(inner.indexOf('|') + 1)] : [inner, ''];
  if (left.endsWith('\\')) left = left.slice(0, -1);
  const hash = left.indexOf('#');
  const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
  const sub = hash >= 0 ? left.slice(hash + 1).trim() : '';
  return { target, sub, display: display.trim() };
}

function wikilinkRule(state: StateInline, silent: boolean) {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 && src.startsWith('[[', pos + 1)) {
    embed = true;
    pos++;
  } else if (!src.startsWith('[[', pos)) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || inner.includes('[[') || inner.includes('\n')) return false;
  if (!silent) {
    const t = state.push(embed ? 'wiki_embed' : 'wikilink', '', 0);
    t.meta = splitInner(inner);
  }
  state.pos = end + 2;
  return true;
}

const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

function tagRule(state: StateInline, silent: boolean) {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x23) return false;
  const prev = pos > 0 ? src[pos - 1] : ' ';
  if (!/[\s(,[*_]/.test(prev)) return false;
  let end = pos + 1;
  while (end < src.length) {
    const cp = src.codePointAt(end)!;
    const ch = String.fromCodePoint(cp);
    if (!TAG_CHAR.test(ch)) break;
    end += ch.length;
  }
  let tag = src.slice(pos + 1, end).replace(/\/+$/, '');
  if (!tag || /^\d+$/.test(tag)) return false;
  if (!silent) {
    const t = state.push('tag', '', 0);
    t.content = tag;
  }
  state.pos = pos + 1 + tag.length;
  return true;
}

function markRule(state: StateInline, silent: boolean) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  const end = src.indexOf('==', start + 2);
  if (end < 0 || end === start + 2 || src[start + 2] === ' ') return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
}

function mathInlineRule(state: StateInline, silent: boolean) {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x24) return false;
  if (src.charCodeAt(pos + 1) === 0x24) {
    const end = src.indexOf('$$', pos + 2);
    if (end < 0) return false;
    if (!silent) {
      const t = state.push('math_inline', '', 0);
      t.content = src.slice(pos + 2, end);
      t.meta = { display: true };
    }
    state.pos = end + 2;
    return true;
  }
  const next = src[pos + 1];
  if (!next || /\s/.test(next)) return false;
  let end = pos + 1;
  while ((end = src.indexOf('$', end)) !== -1) {
    if (src[end - 1] !== '\\') break;
    end++;
  }
  if (end < 0 || /\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? '')) return false;
  if (!silent) {
    const t = state.push('math_inline', '', 0);
    t.content = src.slice(pos + 1, end);
    t.meta = { display: false };
  }
  state.pos = end + 1;
  return true;
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const first = state.src.slice(start, max);
  if (!first.startsWith('$$')) return false;
  if (silent) return true;
  let content = '';
  let line = startLine;
  const rest = first.slice(2);
  if (rest.trim().endsWith('$$') && rest.trim().length > 2) {
    content = rest.trim().slice(0, -2);
  } else {
    const lines: string[] = [rest];
    let found = false;
    while (++line < endLine) {
      const s = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (s.trim().endsWith('$$')) {
        lines.push(s.trim().slice(0, -2));
        found = true;
        break;
      }
      lines.push(s);
    }
    if (!found) return false;
    content = lines.join('\n');
  }
  state.line = line + 1;
  const t = state.push('math_block', 'div', 0);
  t.content = content;
  t.map = [startLine, state.line];
  return true;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code, lang) {
    if (lang === 'mermaid') return `<pre class="mermaid-src">${escapeHtml(code)}</pre>`;
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* sin resaltado */
      }
    }
    return '';
  },
});
md.use(footnote);
md.inline.ruler.before('link', 'wikilink', wikilinkRule);
md.inline.ruler.before('escape', 'math_inline', mathInlineRule);
md.inline.ruler.after('wikilink', 'tag', tagRule);
md.inline.ruler.before('emphasis', 'mark', markRule);
md.block.ruler.before('fence', 'math_block', mathBlockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

md.renderer.rules.wikilink = (tokens, i) => {
  const { target, sub, display } = tokens[i].meta as { target: string; sub: string; display: string };
  const href = target + (sub ? '#' + sub : '');
  const text = display || (target ? titleOf(target) + (sub ? ' › ' + sub.replace(/^\^/, '') : '') : sub.replace(/^\^/, ''));
  return `<a class="internal-link" href="#" data-href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
};
md.renderer.rules.wiki_embed = (tokens, i) => {
  const { target, sub, display } = tokens[i].meta as { target: string; sub: string; display: string };
  return `<span class="internal-embed" data-src="${escapeHtml(target + (sub ? '#' + sub : ''))}" data-alt="${escapeHtml(display)}"></span>`;
};
md.renderer.rules.tag = (tokens, i) => `<a class="tag" href="#" data-tag="${escapeHtml(tokens[i].content)}">#${escapeHtml(tokens[i].content)}</a>`;
md.renderer.rules.math_inline = (tokens, i) =>
  katex.renderToString(tokens[i].content, { throwOnError: false, displayMode: !!tokens[i].meta?.display });
md.renderer.rules.math_block = (tokens, i) =>
  `<div class="math-block" data-line="${tokens[i].attrGet('data-line') ?? ''}">${katex.renderToString(tokens[i].content, { throwOnError: false, displayMode: true })}</div>`;

// Número de línea de origen en cada bloque (para tareas y sincronización de scroll).
md.core.ruler.push('source_lines', (state) => {
  const off = (state.env?.lineOffset as number) ?? 0;
  for (const t of state.tokens) if (t.map && t.nesting >= 0) t.attrSet('data-line', String(t.map[0] + off));
  return true;
});

// ------------------------------------------------------------------ utilidades de contenido

export function splitFrontmatter(src: string): { yaml: string | null; body: string; offset: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { yaml: null, body: src, offset: 0 };
  return { yaml: m[1], body: src.slice(m[0].length), offset: m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0) };
}

/** Elimina %%comentarios%% preservando los saltos de línea. */
function stripComments(s: string) {
  return s.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, ''));
}

/** Extrae la sección de un encabezado o un bloque `^id`. */
export function extractSection(content: string, sub: string): string {
  const lines = content.split('\n');
  if (sub.startsWith('^')) {
    const id = sub.slice(1);
    const i = lines.findIndex((l) => l.trimEnd().endsWith(' ^' + id) || l.trim() === '^' + id);
    if (i < 0) return '';
    if (lines[i].trim() === '^' + id) {
      let s = i - 1;
      while (s > 0 && lines[s - 1].trim()) s--;
      return lines.slice(s, i).join('\n');
    }
    if (/^\s*([-*+]|\d+[.)])\s/.test(lines[i])) return lines[i];
    let s = i;
    while (s > 0 && lines[s - 1].trim()) s--;
    return lines.slice(s, i + 1).join('\n');
  }
  const target = fold(sub.split('#').pop()!.trim());
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0 && fold(m[2]) === target) {
      start = i;
      level = m[1].length;
    } else if (start >= 0 && m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : '';
}

const slug = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
export const headingId = (s: string) => 'h-' + slug(s);

// ------------------------------------------------------------------ renderizado al DOM

export interface RenderOptions {
  sourcePath: string;
  depth?: number;
  onToggleTask?: (line: number, checked: boolean) => void;
  showProperties?: boolean;
}

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎', abstract: '☰', summary: '☰', tldr: '☰', info: 'ℹ', todo: '☑', tip: '🔥', hint: '🔥', important: '🔥',
  success: '✔', check: '✔', done: '✔', question: '?', help: '?', faq: '?', warning: '⚠', caution: '⚠', attention: '⚠',
  failure: '✖', fail: '✖', missing: '✖', danger: '⚡', error: '⚡', bug: '🐞', example: '▤', quote: '❝', cite: '❝',
};

export async function renderMarkdown(app: App, el: HTMLElement, source: string, opts: RenderOptions) {
  const depth = opts.depth ?? 0;
  const { yaml, body, offset } = splitFrontmatter(source);
  const html = md.render(stripComments(body), { lineOffset: offset });
  el.innerHTML = DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-href', 'data-src', 'data-alt', 'data-line', 'data-tag', 'target', 'aria-hidden'],
    FORBID_TAGS: ['style', 'script'],
  });
  el.classList.add('markdown-rendered');

  if (opts.showProperties && yaml) {
    const props = renderProperties(yaml);
    if (props) el.prepend(props);
  }

  postCallouts(el);
  postTasks(el, opts);
  postBlockIds(el);
  el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((hEl) => (hEl.id = headingId(hEl.textContent ?? '')));
  postLinks(app, el, opts.sourcePath);
  await Promise.all([postImages(app, el, opts.sourcePath), postEmbeds(app, el, opts.sourcePath, depth), postMermaid(el)]);
}

function renderProperties(yaml: string): HTMLElement | null {
  const rows: HTMLElement[] = [];
  // Parser YAML mínimo para mostrar (clave: valor / listas simples).
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s#:][^:]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    const items: string[] = [];
    if (!val) {
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s+-\s*/, '').trim());
    } else if (val.startsWith('[') && val.endsWith(']')) {
      items.push(...val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean));
      val = '';
    }
    const valueEl = h('div.property-value');
    const clean = (s: string) => s.replace(/^["']|["']$/g, '');
    if (items.length) {
      for (const it of items) {
        const text = clean(it);
        if (key === 'tags' || key === 'tag') valueEl.append(h('a.tag', { href: '#', dataset: { tag: text.replace(/^#/, '') } }, '#' + text.replace(/^#/, '')));
        else valueEl.append(h('span.property-pill', text));
      }
    } else {
      const text = clean(val);
      const wl = /^\[\[(.+)]]$/.exec(text);
      if (wl) valueEl.append(h('a.internal-link', { href: '#', dataset: { href: splitInner(wl[1]).target } }, splitInner(wl[1]).display || wl[1]));
      else if (key === 'tags' || key === 'tag') text.split(/[\s,]+/).filter(Boolean).forEach((t) => valueEl.append(h('a.tag', { href: '#', dataset: { tag: t.replace(/^#/, '') } }, '#' + t.replace(/^#/, ''))));
      else valueEl.append(text);
    }
    rows.push(h('div.property', h('div.property-key', key), valueEl));
  }
  if (!rows.length) return null;
  return h('div.properties', h('div.properties-title', 'Propiedades'), ...rows);
}

function postCallouts(root: HTMLElement) {
  root.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P') return;
    const first = p.firstChild;
    if (!first || first.nodeType !== Node.TEXT_NODE) return;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/m.exec(first.textContent ?? '');
    if (!m || m.index !== 0) return;
    const type = m[1].toLowerCase();
    const fold = m[2];
    // Título = resto de la primera línea (hasta <br>).
    const titleNodes: Node[] = [];
    first.textContent = (first.textContent ?? '').slice(m[0].length - m[3].length);
    let n: ChildNode | null = p.firstChild;
    while (n && n.nodeName !== 'BR') {
      const next: ChildNode | null = n.nextSibling;
      titleNodes.push(n);
      n = next;
    }
    if (n && n.nodeName === 'BR') n.remove();
    const titleEl = h('div.callout-title-inner');
    titleNodes.forEach((t) => titleEl.append(t));
    if (!titleEl.textContent?.trim()) titleEl.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    if (!p.textContent?.trim() && !p.querySelector('img,.internal-embed')) p.remove();
    const content = h('div.callout-content');
    while (bq.firstChild) content.append(bq.firstChild);
    const callout = h('div.callout', { dataset: { callout: type }, 'data-line': bq.getAttribute('data-line') ?? '' },
      h('div.callout-title', h('span.callout-icon', CALLOUT_ICONS[type] ?? '✎'), titleEl, fold ? h('span.callout-fold', '▾') : null),
      content,
    );
    if (fold) {
      callout.classList.add('is-collapsible');
      if (fold === '-') callout.classList.add('is-collapsed');
      callout.firstElementChild!.addEventListener('click', () => callout.classList.toggle('is-collapsed'));
    }
    bq.replaceWith(callout);
  });
}

function postTasks(root: HTMLElement, opts: RenderOptions) {
  root.querySelectorAll('li').forEach((li) => {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode() as Text | null;
    if (!t) return;
    // Solo si el texto es el primer contenido del li (o de su primer <p>).
    const holder = t.parentElement;
    if (holder !== li && !(holder?.tagName === 'P' && holder.parentElement === li)) return;
    const m = /^\[(.)\]\s/.exec(t.data);
    if (!m) return;
    t.data = t.data.slice(m[0].length);
    const checked = m[1] !== ' ';
    const cb = h('input.task-list-item-checkbox', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = checked;
    const line = Number(li.getAttribute('data-line'));
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opts.onToggleTask && !Number.isNaN(line)) opts.onToggleTask(line, cb.checked);
      else e.preventDefault();
    });
    holder!.insertBefore(cb, holder!.firstChild);
    li.classList.add('task-list-item');
    if (checked) li.classList.add('is-checked');
    li.dataset.task = m[1];
    li.parentElement?.classList.add('contains-task-list');
  });
}

function postBlockIds(root: HTMLElement) {
  root.querySelectorAll('p, li').forEach((b) => {
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text;
    if (!last) return;
    const m = /\s\^([A-Za-z0-9-]+)\s*$/.exec(last.data);
    if (m) {
      last.data = last.data.slice(0, m.index);
      (b as HTMLElement).id = '^' + m[1];
      (b as HTMLElement).dataset.blockId = m[1];
    }
  });
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');

function postLinks(app: App, root: HTMLElement, source: string) {
  root.querySelectorAll<HTMLAnchorElement>('a').forEach((a) => {
    if (a.classList.contains('tag') || a.classList.contains('footnote-backref') || a.closest('.footnote-ref')) return;
    if (a.classList.contains('internal-link')) {
      const href = a.dataset.href ?? '';
      const target = href.split('#')[0];
      const resolved = target ? app.resolver.resolve(target, source) : source;
      if (!resolved) a.classList.add('is-unresolved');
      a.title = resolved ?? `${target} (no existe — clic para crear)`;
      return;
    }
    const raw = a.getAttribute('href') ?? '';
    if (!raw || raw.startsWith('#')) return;
    if (isExternal(raw)) {
      a.classList.add('external-link');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      return;
    }
    // Enlace markdown a archivo local → enlace interno.
    let dec = raw;
    try {
      dec = decodeURIComponent(raw);
    } catch {
      /* tal cual */
    }
    a.classList.add('internal-link');
    a.dataset.href = dec;
    a.setAttribute('href', '#');
    const resolved = app.resolver.resolve(dec.split('#')[0], source);
    if (!resolved) a.classList.add('is-unresolved');
  });
}

async function postImages(app: App, root: HTMLElement, source: string) {
  const imgs = [...root.querySelectorAll<HTMLImageElement>('img')].filter((i) => !i.closest('.internal-embed'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      if (!src || isExternal(src)) return;
      let dec = src;
      try {
        dec = decodeURIComponent(src);
      } catch {
        /* tal cual */
      }
      const r = app.resolver.resolve(dec, source);
      if (r) img.src = await app.backend.resourceUrl(r);
      img.loading = 'lazy';
    }),
  );
}

function applySize(el: HTMLElement, alt: string) {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alt.trim());
  if (m) {
    el.style.width = m[1] + 'px';
    if (m[2]) el.style.height = m[2] + 'px';
    return true;
  }
  return false;
}

async function postEmbeds(app: App, root: HTMLElement, source: string, depth: number) {
  const embeds = [...root.querySelectorAll<HTMLElement>('span.internal-embed')];
  await Promise.all(embeds.map((e) => renderEmbed(app, e, source, depth)));
}

async function renderEmbed(app: App, el: HTMLElement, source: string, depth: number) {
  const src = el.dataset.src ?? '';
  const alt = el.dataset.alt ?? '';
  const [target, ...subParts] = src.split('#');
  const sub = subParts.join('#');
  const resolved = target ? app.resolver.resolve(target, source) : source;
  if (!resolved) {
    el.classList.add('is-unresolved');
    el.append(h('a.internal-link.is-unresolved', { href: '#', dataset: { href: src } }, `«${target}» no existe`));
    return;
  }
  const ext = extname(resolved);
  if (IMAGE_EXT.has(ext)) {
    const img = h('img', { src: await app.backend.resourceUrl(resolved), alt: alt || titleOf(resolved), loading: 'lazy' }) as HTMLImageElement;
    applySize(img, alt);
    el.classList.add('image-embed');
    el.append(img);
    return;
  }
  if (AUDIO_EXT.has(ext) && ext !== 'webm') {
    el.append(h('audio', { controls: true, src: await app.backend.resourceUrl(resolved) }));
    return;
  }
  if (VIDEO_EXT.has(ext)) {
    el.append(h('video', { controls: true, src: await app.backend.resourceUrl(resolved), style: { maxWidth: '100%' } }));
    return;
  }
  if (ext === 'pdf') {
    const url = await app.backend.resourceUrl(resolved);
    el.classList.add('pdf-embed');
    el.append(h('iframe', { src: url + (sub ? '#' + sub : ''), style: { width: '100%', height: '600px', border: '0' } }));
    return;
  }
  if (ext === 'md') {
    el.classList.add('markdown-embed');
    const titleLink = h('a.internal-link.markdown-embed-link', { href: '#', dataset: { href: src }, title: 'Abrir' });
    titleLink.append(icon('link', 14));
    const head = h('div.markdown-embed-title', alt || titleOf(resolved) + (sub ? ' › ' + sub : ''));
    const content = h('div.markdown-embed-content');
    el.append(titleLink, head, content);
    if (depth >= 3) {
      content.append(h('em', 'Incrustación demasiado profunda'));
      return;
    }
    let text = await app.backend.read(resolved);
    if (sub) text = extractSection(text, sub);
    else text = splitFrontmatter(text).body;
    await renderMarkdown(app, content, text, { sourcePath: resolved, depth: depth + 1 });
    return;
  }
  el.append(h('a.internal-link', { href: '#', dataset: { href: src } }, '📎 ' + titleOf(resolved)));
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

async function postMermaid(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre.mermaid-src')];
  if (!blocks.length) return;
  mermaidPromise ??= import('mermaid').then((m) => {
    const dark = document.body.classList.contains('theme-dark');
    m.default.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
    return m.default;
  });
  const mermaid = await mermaidPromise;
  for (const b of blocks) {
    const code = b.textContent ?? '';
    const id = 'mmd-' + Math.random().toString(36).slice(2);
    try {
      const { svg } = await mermaid.render(id, code);
      const div = h('div.mermaid');
      div.innerHTML = svg;
      b.replaceWith(div);
    } catch (e) {
      b.classList.add('mermaid-error');
      b.title = String(e);
    }
  }
}

/** Texto plano de una nota (para exportar / vistas previas). */
export function renderToHtmlString(source: string): string {
  const { body } = splitFrontmatter(source);
  return DOMPurify.sanitize(md.render(stripComments(body)));
}
