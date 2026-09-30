import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, dropCursor, keymap, lineNumbers, rectangularSelection, crosshairCursor, placeholder } from '@codemirror/view';
import type { App } from '../core/app';
import { basename, dirname, icon, stripExt, titleOf } from '../core/util';
import { livePreview, type LinkContext } from './livepreview';
import { obsidianHighlight, obsidianMarkdown } from './syntax';

/** Marca los cambios de documento que vienen de disco (no deben re-guardarse). */
export const externalLoad = Annotation.define<boolean>();

export interface EditorHandle {
  view: EditorView;
  setDoc(text: string, keepSelection?: boolean): void;
  reconfigure(): void;
  setLive(live: boolean): void;
}

// ------------------------------------------------------------------ comandos de formato

export function toggleWrap(view: EditorView, before: string, after = before) {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    const b = view.state.sliceDoc(range.from - before.length, range.from);
    const a = view.state.sliceDoc(range.to, range.to + after.length);
    if (b === before && a === after) {
      return {
        changes: [{ from: range.from - before.length, to: range.from }, { from: range.to, to: range.to + after.length }],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      };
    }
    if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length) {
      return {
        changes: { from: range.from, to: range.to, insert: text.slice(before.length, text.length - after.length) },
        range: EditorSelection.range(range.from, range.to - before.length - after.length),
      };
    }
    return {
      changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });
  view.dispatch(changes, { scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}

export function toggleTaskAtCursor(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s)(\[(.)\]\s)?/.exec(line.text);
  let change;
  if (m && m[2]) {
    const pos = line.from + m[1].length + 1;
    change = { from: pos, to: pos + 1, insert: m[3] === ' ' ? 'x' : ' ' };
  } else if (m) {
    change = { from: line.from + m[1].length, insert: '[ ] ' };
  } else {
    const indent = /^\s*/.exec(line.text)![0];
    change = { from: line.from + indent.length, insert: '- [ ] ' };
  }
  view.dispatch({ changes: change, userEvent: 'input' });
  return true;
}

export function insertAtCursor(view: EditorView, text: string) {
  const r = view.state.selection.main;
  view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length }, userEvent: 'input' });
  view.focus();
}

export function scrollToLine(view: EditorView, line: number, select = true) {
  const n = Math.max(1, Math.min(view.state.doc.lines, line + 1));
  const l = view.state.doc.line(n);
  view.dispatch({
    selection: select ? { anchor: l.from } : undefined,
    effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 80 }),
  });
}

// ------------------------------------------------------------------ autocompletado

function linkTextFor(app: App, path: string, source: string) {
  const isMd = path.toLowerCase().endsWith('.md');
  const name = isMd ? titleOf(path) : basename(path);
  return app.resolver.resolve(name, source) === path ? name : isMd ? stripExt(path) : path;
}

function linkCompletion(app: App, getPath: () => string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(/\[\[[^\]\n[]*$/);
    if (!m) return null;
    const query = m.text.slice(2);
    if (query.includes('|')) return null;
    const from = m.from + 2;
    const source = getPath();
    const closeFor = (view: EditorView, to: number) => (view.state.sliceDoc(to, to + 2) === ']]' ? '' : ']]');
    const applyText = (text: string) => (view: EditorView, _c: Completion, f: number, t: number) => {
      const close = closeFor(view, t);
      view.dispatch({
        changes: { from: f, to: t, insert: text + close },
        selection: { anchor: f + text.length + 2 },
        userEvent: 'input.complete',
      });
    };

    const hash = query.indexOf('#');
    if (hash >= 0) {
      const note = query.slice(0, hash);
      const target = note ? app.resolver.resolve(note, source) : source;
      if (!target) return null;
      const meta = await app.backend.meta(target);
      if (!meta) return null;
      const sub = query.slice(hash + 1);
      const options: Completion[] = sub.startsWith('^')
        ? meta.blockIds.map((b) => ({ label: '^' + b, apply: applyText(`${note}#^${b}`), type: 'constant' }))
        : meta.headings.map((hd) => ({
            label: hd.text,
            detail: 'H' + hd.level,
            apply: applyText(`${note}#${hd.text}`),
            type: 'property',
          }));
      return { from: from + hash + 1, options, validFor: /^[^\]#|]*$/ };
    }

    const hits = await app.backend.quickSwitch(query, 40);
    const options: Completion[] = hits.map((hit, i) => {
      const text = linkTextFor(app, hit.path, source);
      const label = hit.alias ?? hit.title;
      return {
        label,
        detail: hit.alias ? `→ ${hit.title}` : dirname(hit.path) || undefined,
        type: hit.isNote ? 'text' : 'variable',
        boost: 99 - i,
        apply: applyText(hit.alias ? `${text}|${hit.alias}` : text),
      };
    });
    if (query.trim() && !hits.some((x) => x.title.toLowerCase() === query.trim().toLowerCase())) {
      options.push({ label: query.trim(), detail: 'Crear enlace a nota nueva', type: 'keyword', boost: -99, apply: applyText(query.trim()) });
    }
    return { from, options, filter: false };
  };
}

function tagCompletion(app: App) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(/(?:^|[\s(,])#[\p{L}\p{N}_\-/]*$/u);
    if (!m) return null;
    const hashAt = m.text.lastIndexOf('#');
    if (hashAt === m.text.length - 1 && !ctx.explicit && m.text.length === 1 && ctx.pos === m.from + 1) {
      // "#" al inicio de línea podría ser un encabezado: sólo sugerir si hay etiquetas.
    }
    const tags = await app.tagCache();
    return {
      from: m.from + hashAt + 1,
      options: tags.map((t) => ({ label: t.tag, detail: String(t.count), type: 'keyword' })),
      validFor: /^[\p{L}\p{N}_\-/]*$/u,
    };
  };
}

// ------------------------------------------------------------------ creación

export function createEditor(parent: HTMLElement, app: App, getPath: () => string, onChange: () => void): EditorHandle {
  const lpComp = new Compartment();
  const lineNumComp = new Compartment();
  const foldComp = new Compartment();
  const vimComp = new Compartment();
  const attrComp = new Compartment();

  const ctx: LinkContext = {
    sourcePath: getPath,
    resolve: (t) => app.resolver.resolve(t, getPath()),
    resourceUrl: (p) => app.backend.resourceUrl(p),
    openLink: (href, newTab) => void app.openLinkText(href, getPath(), { newLeaf: newTab }),
    openTag: (tag) => app.searchFor(`tag:#${tag}`),
  };

  const s = () => app.settings;
  const lpExt = () => livePreview(ctx, s().livePreview);
  const lineNumExt = () => (s().lineNumbers ? lineNumbers() : []);
  const foldExt = () => (s().foldGutter ? foldGutter({ markerDOM: (open) => { const e = document.createElement('span'); e.className = 'cm-fold-marker' + (open ? ' is-open' : ''); e.append(icon('chevron', 12)); return e; } }) : []);
  const attrExt = () => EditorView.contentAttributes.of({ spellcheck: String(s().spellcheck), autocorrect: 'on', autocapitalize: 'sentences' });
  let vimLoaded: Extension | null = null;
  const vimExt = async (): Promise<Extension> => {
    if (!s().vimMode) return [];
    if (!vimLoaded) vimLoaded = (await import('@replit/codemirror-vim')).vim();
    return vimLoaded;
  };

  const formatKeys = keymap.of([
    { key: 'Mod-b', run: (v) => toggleWrap(v, '**') },
    { key: 'Mod-i', run: (v) => toggleWrap(v, '*') },
    { key: 'Mod-Shift-x', run: (v) => toggleWrap(v, '~~') },
    { key: 'Mod-Shift-h', run: (v) => toggleWrap(v, '==') },
    { key: 'Mod-`', run: (v) => toggleWrap(v, '`') },
    { key: 'Mod-/', run: (v) => toggleWrap(v, '%%') },
    { key: 'Mod-k', run: (v) => toggleWrap(v, '[[', ']]') },
    { key: 'Mod-l', run: toggleTaskAtCursor },
    { key: 'Mod-Enter', run: toggleTaskAtCursor },
  ]);

  const saveAttachment = async (file: File, view: EditorView, pos?: number) => {
    const path = await app.saveAttachment(file, getPath());
    const name = linkTextFor(app, path, getPath());
    const text = `![[${name}]]`;
    const at = pos ?? view.state.selection.main.from;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
  };

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    indentOnInput(),
    closeBrackets(),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    EditorView.lineWrapping,
    placeholder('Empieza a escribir…'),
    yamlFrontmatter({
      content: markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [obsidianMarkdown], completeHTMLTags: false }),
    }),
    syntaxHighlighting(obsidianHighlight),
    autocompletion({ override: [linkCompletion(app, getPath), tagCompletion(app)], activateOnTyping: true, icons: false }),
    formatKeys,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    lpComp.of(lpExt()),
    lineNumComp.of(lineNumExt()),
    foldComp.of(foldExt()),
    attrComp.of(attrExt()),
    vimComp.of([]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.every((t) => t.annotation(externalLoad))) onChange();
    }),
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return false;
        e.preventDefault();
        files.forEach((f) => void saveAttachment(f, view));
        return true;
      },
      drop(e, view) {
        const files = [...(e.dataTransfer?.files ?? [])];
        const internal = e.dataTransfer?.getData('text/x-nexo-path');
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
        if (internal) {
          e.preventDefault();
          const txt = `[[${linkTextFor(app, internal, getPath())}]]`;
          const at = pos ?? view.state.selection.main.from;
          view.dispatch({ changes: { from: at, insert: txt } });
          return true;
        }
        if (!files.length) return false;
        e.preventDefault();
        files.forEach((f) => void saveAttachment(f, view, pos));
        return true;
      },
    }),
  ];

  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });

  void vimExt().then((v) => view.dispatch({ effects: vimComp.reconfigure(v) }));

  return {
    view,
    setDoc(text: string, keepSelection = false) {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: keepSelection ? { anchor: Math.min(sel.anchor, text.length), head: Math.min(sel.head, text.length) } : { anchor: 0 },
        annotations: [externalLoad.of(true)],
      });
    },
    reconfigure() {
      view.dispatch({
        effects: [lpComp.reconfigure(lpExt()), lineNumComp.reconfigure(lineNumExt()), foldComp.reconfigure(foldExt()), attrComp.reconfigure(attrExt())],
      });
      void vimExt().then((v) => view.dispatch({ effects: vimComp.reconfigure(v) }));
    },
    setLive(live: boolean) {
      view.dispatch({ effects: lpComp.reconfigure(livePreview(ctx, live)) });
    },
  };
}
