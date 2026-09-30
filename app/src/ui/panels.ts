import type { Backlink } from '../backend/types';
import type { App } from '../core/app';
import {
  basename, debounce, dirname, escapeHtml, extname, fold, h, highlightTerms, icon, iconButton, isNote, titleOf,
} from '../core/util';
import { MarkdownView } from '../views/markdown';
import { GraphRenderer } from '../views/graph';
import { showMenu, type MenuItem } from './modals';

export abstract class Panel {
  abstract readonly id: string;
  abstract readonly title: string;
  abstract readonly iconName: string;
  readonly el = h('div.panel');
  visible = false;
  private stale = true;
  constructor(readonly app: App) {}
  /** Marca como obsoleto y refresca sólo si está visible. */
  invalidate = debounce(() => {
    this.stale = true;
    if (this.visible) void this.doRefresh();
  }, 120);
  show() {
    this.visible = true;
    if (this.stale) void this.doRefresh();
  }
  hide() {
    this.visible = false;
  }
  private async doRefresh() {
    this.stale = false;
    await this.refresh();
  }
  abstract refresh(): Promise<void> | void;
}

export class Sidebar {
  el: HTMLElement;
  private header: HTMLElement;
  private body: HTMLElement;
  active: Panel | null = null;
  constructor(readonly side: 'left' | 'right', readonly panels: Panel[]) {
    this.header = h('div.sidebar-tabs');
    this.body = h('div.sidebar-body');
    this.el = h(`div.sidebar.sidebar-${side}`, this.header, this.body, h('div.sidebar-resizer'));
    for (const p of panels) {
      const b = iconButton(p.iconName, p.title, () => this.activate(p.id), 'sidebar-tab');
      b.dataset.panel = p.id;
      this.header.append(b);
    }
    this.bindResize();
    const saved = localStorage.getItem(`nexo.sidebar.${side}.width`);
    if (saved) this.el.style.width = saved + 'px';
    this.activate(localStorage.getItem(`nexo.sidebar.${side}.panel`) ?? panels[0].id);
  }

  activate(id: string) {
    const p = this.panels.find((x) => x.id === id) ?? this.panels[0];
    if (this.active === p) return p;
    this.active?.hide();
    this.active = p;
    this.body.replaceChildren(p.el);
    p.show();
    this.header.querySelectorAll<HTMLElement>('.sidebar-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.panel === p.id));
    localStorage.setItem(`nexo.sidebar.${this.side}.panel`, p.id);
    return p;
  }

  toggle(force?: boolean) {
    const collapsed = force === undefined ? !this.el.classList.contains('is-collapsed') : !force;
    this.el.classList.toggle('is-collapsed', collapsed);
    document.body.classList.toggle(`${this.side}-open`, !collapsed);
    if (!collapsed) this.active?.show();
    else this.active?.hide();
  }

  isOpen() {
    return !this.el.classList.contains('is-collapsed');
  }

  private bindResize() {
    const handle = this.el.querySelector('.sidebar-resizer') as HTMLElement;
    handle.addEventListener('pointerdown', (e) => {
      const startX = e.clientX;
      const startW = this.el.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const w = Math.min(700, Math.max(180, startW + (this.side === 'left' ? dx : -dx)));
        this.el.style.width = w + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        localStorage.setItem(`nexo.sidebar.${this.side}.width`, String(Math.round(this.el.getBoundingClientRect().width)));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
}

// ------------------------------------------------------------------ explorador de archivos

interface TreeNode {
  name: string;
  path: string;
  folder: boolean;
  children: TreeNode[];
  mtime: number;
}

export class FileExplorer extends Panel {
  readonly id = 'files';
  readonly title = 'Archivos';
  readonly iconName = 'folder';
  private tree = h('div.nav-files');
  private collapsed = new Set<string>(JSON.parse(localStorage.getItem('nexo.explorer.collapsed') ?? '[]'));
  private sort: 'name' | 'name-desc' | 'mtime' | 'mtime-asc' = (localStorage.getItem('nexo.explorer.sort') as any) ?? 'name';

  constructor(app: App) {
    super(app);
    const bar = h('div.nav-header',
      iconButton('newNote', 'Nota nueva', () => void app.createNote()),
      iconButton('newFolder', 'Carpeta nueva', () => void app.createFolder(app.newNoteFolder(app.activePath()))),
      iconButton('sort', 'Ordenar', (e) => this.sortMenu(e)),
      iconButton('collapse', 'Plegar todo', () => {
        app.folders.forEach((f) => this.collapsed.add(f));
        this.persist();
        this.invalidate();
      }),
    );
    this.el.append(bar, this.tree);
    this.tree.addEventListener('contextmenu', (e) => {
      if (e.target === this.tree) {
        e.preventDefault();
        this.menuFor('', true, e);
      }
    });
    this.tree.addEventListener('dragover', (e) => e.preventDefault());
    this.tree.addEventListener('drop', (e) => {
      if (e.target !== this.tree) return;
      const p = e.dataTransfer?.getData('text/x-nexo-path');
      if (p) void app.move(p, '');
    });
    for (const ev of ['files-changed', 'renamed', 'deleted', 'vault-opened'] as const) app.events.on(ev, () => this.invalidate());
    app.events.on('active-changed', () => this.markActive());
    app.events.on('reveal-file', ({ path }) => this.reveal(path));
  }

  private persist() {
    localStorage.setItem('nexo.explorer.collapsed', JSON.stringify([...this.collapsed]));
  }

  private sortMenu(e: MouseEvent) {
    const set = (s: typeof this.sort) => () => {
      this.sort = s;
      localStorage.setItem('nexo.explorer.sort', s);
      this.invalidate();
    };
    showMenu(
      [
        { title: 'Nombre (A → Z)', onClick: set('name') },
        { title: 'Nombre (Z → A)', onClick: set('name-desc') },
        { title: 'Modificado (reciente primero)', onClick: set('mtime') },
        { title: 'Modificado (antiguo primero)', onClick: set('mtime-asc') },
      ],
      e.clientX,
      e.clientY,
    );
  }

  private build(): TreeNode {
    const root: TreeNode = { name: '', path: '', folder: true, children: [], mtime: 0 };
    const folders = new Map<string, TreeNode>([['', root]]);
    const ensure = (path: string): TreeNode => {
      let f = folders.get(path);
      if (f) return f;
      const parent = ensure(dirname(path));
      f = { name: basename(path), path, folder: true, children: [], mtime: 0 };
      parent.children.push(f);
      folders.set(path, f);
      return f;
    };
    [...this.app.folders].forEach(ensure);
    for (const file of this.app.files) {
      const parent = ensure(dirname(file.path));
      parent.children.push({ name: basename(file.path), path: file.path, folder: false, children: [], mtime: file.mtime });
      parent.mtime = Math.max(parent.mtime, file.mtime);
    }
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const cmp = (a: TreeNode, b: TreeNode) => {
      if (a.folder !== b.folder) return a.folder ? -1 : 1;
      switch (this.sort) {
        case 'name-desc': return coll.compare(b.name, a.name);
        case 'mtime': return b.mtime - a.mtime || coll.compare(a.name, b.name);
        case 'mtime-asc': return a.mtime - b.mtime || coll.compare(a.name, b.name);
        default: return coll.compare(a.name, b.name);
      }
    };
    const sortRec = (n: TreeNode) => {
      n.children.sort(cmp);
      n.children.forEach(sortRec);
    };
    sortRec(root);
    return root;
  }

  refresh() {
    const root = this.build();
    const frag = document.createDocumentFragment();
    const renderChildren = (n: TreeNode, into: Node, depth: number) => {
      for (const c of n.children) into.appendChild(this.renderNode(c, depth));
    };
    renderChildren(root, frag, 0);
    this.tree.replaceChildren(frag);
    this.markActive();
  }

  private renderNode(n: TreeNode, depth: number): HTMLElement {
    const collapsed = this.collapsed.has(n.path);
    const ext = extname(n.name);
    const label = n.folder ? n.name : isNote(n.name) ? titleOf(n.name) : n.name;
    const self = h('div.nav-item' + (n.folder ? '.nav-folder-title' : '.nav-file-title'), {
      draggable: 'true',
      style: { paddingLeft: 8 + depth * 14 + 'px' },
      dataset: { path: n.path },
      title: n.path,
    });
    if (n.folder) self.append(h('span.nav-folder-collapse' + (collapsed ? '.is-collapsed' : ''), icon('chevron', 12)));
    self.append(h('span.nav-item-name', label));
    if (!n.folder && ext && ext !== 'md') self.append(h('span.nav-file-tag', ext.toUpperCase()));

    self.addEventListener('click', (e) => {
      if (n.folder) {
        if (collapsed) this.collapsed.delete(n.path);
        else this.collapsed.add(n.path);
        this.persist();
        this.refresh();
      } else {
        void this.app.open(n.path, { newLeaf: e.ctrlKey || e.metaKey });
        document.body.classList.remove('left-open-mobile');
      }
    });
    self.addEventListener('auxclick', (e) => e.button === 1 && !n.folder && void this.app.open(n.path, { newLeaf: true }));
    self.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.menuFor(n.path, n.folder, e);
    });
    self.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('text/x-nexo-path', n.path);
      e.dataTransfer!.setData('text/plain', n.folder ? n.path : `[[${isNote(n.path) ? titleOf(n.path) : n.name}]]`);
      e.dataTransfer!.effectAllowed = 'copyMove';
    });
    if (n.folder) {
      self.addEventListener('dragover', (e) => {
        e.preventDefault();
        self.classList.add('is-drop-target');
      });
      self.addEventListener('dragleave', () => self.classList.remove('is-drop-target'));
      self.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        self.classList.remove('is-drop-target');
        const p = e.dataTransfer?.getData('text/x-nexo-path');
        if (p) void this.app.move(p, n.path);
      });
    }
    if (!n.folder) return self;
    const wrap = h('div.nav-folder', self);
    if (!collapsed) {
      const kids = h('div.nav-folder-children');
      for (const c of n.children) kids.append(this.renderNode(c, depth + 1));
      wrap.append(kids);
    }
    return wrap;
  }

  private menuFor(path: string, folder: boolean, e: MouseEvent) {
    const app = this.app;
    const items: MenuItem[] = [];
    if (folder) {
      items.push(
        { title: 'Nota nueva', onClick: () => void app.createNote(path) },
        { title: 'Carpeta nueva', onClick: () => void app.createFolder(path) },
        { title: 'Lienzo nuevo', onClick: () => void app.createCanvas(path) },
      );
    } else {
      items.push(
        { title: 'Abrir en pestaña nueva', onClick: () => void app.open(path, { newLeaf: true }) },
        { title: 'Abrir a la derecha', onClick: () => void app.open(path, { newLeaf: 'split' }) },
        { title: app.bookmarks.includes(path) ? 'Quitar marcador' : 'Añadir marcador', onClick: () => app.toggleBookmark(path) },
      );
    }
    if (path) {
      items.push(
        { separator: true, title: '' },
        { title: 'Renombrar…', onClick: () => void app.promptRename(path) },
        { title: 'Copiar ruta', onClick: () => void navigator.clipboard.writeText(path) },
      );
      if (!folder && isNote(path)) items.push({ title: 'Copiar enlace', onClick: () => void navigator.clipboard.writeText(`[[${titleOf(path)}]]`) });
      items.push({ separator: true, title: '' }, { title: 'Eliminar', danger: true, onClick: () => void app.delete(path) });
    }
    showMenu(items, e.clientX, e.clientY);
  }

  private markActive() {
    const active = this.app.activePath();
    this.tree.querySelectorAll('.nav-file-title.is-active').forEach((x) => x.classList.remove('is-active'));
    if (!active) return;
    const el = this.tree.querySelector(`.nav-file-title[data-path="${CSS.escape(active)}"]`);
    el?.classList.add('is-active');
  }

  reveal(path: string) {
    let d = dirname(path);
    while (d) {
      this.collapsed.delete(d);
      d = dirname(d);
    }
    this.persist();
    this.refresh();
    this.tree.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' });
  }
}

// ------------------------------------------------------------------ búsqueda

export class SearchPanel extends Panel {
  readonly id = 'search';
  readonly title = 'Buscar';
  readonly iconName = 'search';
  input: HTMLInputElement;
  private results = h('div.search-results');
  private info = h('div.search-info');
  private seq = 0;

  constructor(app: App) {
    super(app);
    this.input = h('input.search-input', { type: 'search', placeholder: 'Buscar…  (tag:#x  path:  file:  "frase"  -excluir  task:)', spellcheck: 'false' }) as HTMLInputElement;
    this.input.addEventListener('input', debounce(() => void this.run(), 120));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.results.querySelector<HTMLElement>('.search-result-title');
        first?.click();
      }
    });
    this.el.append(h('div.search-box', this.input), this.info, this.results);
    app.events.on('modified', () => this.input.value && this.invalidate());
    app.events.on('files-changed', () => this.input.value && this.invalidate());
  }

  setQuery(q: string) {
    this.input.value = q;
    void this.run();
    this.input.focus();
  }

  refresh() {
    return this.run();
  }

  private async run() {
    const q = this.input.value.trim();
    const my = ++this.seq;
    if (!q) {
      this.results.replaceChildren();
      this.info.textContent = '';
      return;
    }
    const t0 = performance.now();
    const hits = await this.app.backend.search(q, 200);
    if (my !== this.seq) return;
    const ms = performance.now() - t0;
    this.info.textContent = `${hits.length}${hits.length === 200 ? '+' : ''} resultado(s) · ${ms.toFixed(1)} ms`;
    const frag = document.createDocumentFragment();
    for (const hit of hits) {
      const title = h('div.search-result-title', { html: highlightTerms(hit.title, hit.terms), title: hit.path, onclick: (e: MouseEvent) => void this.app.open(hit.path, { newLeaf: e.ctrlKey || e.metaKey }) });
      const matches = hit.matches.map((m) =>
        h('div.search-result-match', {
          html: highlightTerms(m.text, hit.terms),
          onclick: (e: MouseEvent) => void this.app.open(hit.path, { line: m.line, newLeaf: e.ctrlKey || e.metaKey }),
        }),
      );
      frag.append(h('div.search-result', title, h('div.search-result-path', dirname(hit.path)), ...matches));
    }
    this.results.replaceChildren(frag);
  }
}

// ------------------------------------------------------------------ marcadores

export class BookmarksPanel extends Panel {
  readonly id = 'bookmarks';
  readonly title = 'Marcadores';
  readonly iconName = 'bookmark';
  constructor(app: App) {
    super(app);
    app.events.on('bookmarks', () => this.invalidate());
    app.events.on('vault-opened', () => this.invalidate());
  }
  refresh() {
    const list = this.app.bookmarks.map((p) =>
      h('div.nav-item.nav-file-title', {
        onclick: (e: MouseEvent) => void this.app.open(p, { newLeaf: e.ctrlKey || e.metaKey }),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          showMenu([{ title: 'Quitar marcador', onClick: () => this.app.toggleBookmark(p) }], e.clientX, e.clientY);
        },
        title: p,
      }, icon('star', 14), h('span.nav-item-name', titleOf(p))),
    );
    this.el.replaceChildren(h('div.panel-title', 'Marcadores'), ...(list.length ? list : [h('div.panel-empty', 'Sin marcadores. Usa «Añadir marcador» en el menú de un archivo o Ctrl+Shift+B.')]));
  }
}

// ------------------------------------------------------------------ etiquetas

export class TagsPanel extends Panel {
  readonly id = 'tags';
  readonly title = 'Etiquetas';
  readonly iconName = 'tag';
  constructor(app: App) {
    super(app);
    app.events.on('modified', () => this.invalidate());
    app.events.on('files-changed', () => this.invalidate());
  }
  async refresh() {
    const tags = await this.app.backend.tags();
    // Jerarquía por "/".
    interface TN { name: string; full: string; count: number; kids: Map<string, TN> }
    const root: TN = { name: '', full: '', count: 0, kids: new Map() };
    for (const t of tags) {
      let cur = root;
      const parts = t.tag.split('/');
      parts.forEach((p, i) => {
        const full = parts.slice(0, i + 1).join('/');
        const key = p.toLowerCase();
        if (!cur.kids.has(key)) cur.kids.set(key, { name: p, full, count: 0, kids: new Map() });
        cur = cur.kids.get(key)!;
        cur.count += t.count;
      });
    }
    const render = (n: TN, depth: number): HTMLElement[] =>
      [...n.kids.values()]
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .flatMap((k) => [
          h('div.tag-pane-tag', { style: { paddingLeft: 8 + depth * 14 + 'px' }, onclick: () => this.app.searchFor(`tag:#${k.full}`) },
            h('span.tag-pane-tag-text', '#' + k.name), h('span.tag-pane-tag-count', String(k.count))),
          ...render(k, depth + 1),
        ]);
    const items = render(root, 0);
    this.el.replaceChildren(h('div.panel-title', `Etiquetas (${tags.length})`), ...(items.length ? items : [h('div.panel-empty', 'Aún no hay etiquetas.')]));
  }
}

// ------------------------------------------------------------------ tareas

export class TasksPanel extends Panel {
  readonly id = 'tasks';
  readonly title = 'Tareas';
  readonly iconName = 'check';
  private showDone = false;
  constructor(app: App) {
    super(app);
    app.events.on('modified', () => this.invalidate());
    app.events.on('files-changed', () => this.invalidate());
  }
  async refresh() {
    const tasks = await this.app.backend.tasks(this.showDone);
    const toggle = h('label.panel-toggle', h('input', { type: 'checkbox', checked: this.showDone, onchange: (e: Event) => { this.showDone = (e.target as HTMLInputElement).checked; void this.refresh(); } }), ' Mostrar completadas');
    const groups = new Map<string, typeof tasks>();
    for (const t of tasks) (groups.get(t.path) ?? groups.set(t.path, []).get(t.path)!).push(t);
    const out: HTMLElement[] = [];
    for (const [path, ts] of groups) {
      out.push(h('div.tree-item-title', { onclick: () => void this.app.open(path) }, titleOf(path), h('span.tree-count', String(ts.length))));
      for (const t of ts) {
        const cb = h('input', { type: 'checkbox', checked: t.done }) as HTMLInputElement;
        cb.addEventListener('click', async (e) => {
          e.stopPropagation();
          const content = await this.app.backend.read(t.path);
          const lines = content.split('\n');
          lines[t.line] = lines[t.line].replace(/\[(.)\]/, cb.checked ? '[x]' : '[ ]');
          await this.app.writeFile(t.path, lines.join('\n'));
          for (const l of this.app.workspace.leaves()) l.view.onExternalChange([t.path]);
        });
        out.push(h('div.task-row' + (t.done ? '.is-done' : ''), { onclick: () => void this.app.open(t.path, { line: t.line }) }, cb, h('span', t.text || '(vacía)')));
      }
    }
    this.el.replaceChildren(h('div.panel-title', `Tareas (${tasks.length})`), toggle, ...(out.length ? out : [h('div.panel-empty', 'Sin tareas pendientes 🎉')]));
  }
}

// ------------------------------------------------------------------ panel derecho: retroenlaces

abstract class ActivePanel extends Panel {
  constructor(app: App) {
    super(app);
    app.events.on('active-changed', () => this.invalidate());
    app.events.on('modified', () => this.invalidate());
    app.events.on('files-changed', () => this.invalidate());
  }
  protected current(): string | null {
    const p = this.app.activePath();
    return p && isNote(p) ? p : null;
  }
}

function mentionList(app: App, items: Backlink[], title: string, terms: string[], onLink?: (source: string, line: number) => void) {
  const out = h('div.backlink-group');
  const count = items.reduce((a, b) => a + b.mentions.length, 0);
  out.append(h('div.tree-item-title.is-header', title, h('span.tree-count', String(count))));
  if (!items.length) out.append(h('div.panel-empty', 'Ninguna.'));
  for (const b of items) {
    out.append(h('div.tree-item-title', { onclick: (e: MouseEvent) => void app.open(b.source, { newLeaf: e.ctrlKey || e.metaKey }) }, icon('file', 13), ' ', titleOf(b.source)));
    for (const m of b.mentions) {
      const row = h('div.search-result-match', { html: highlightTerms(m.text, terms), onclick: () => void app.open(b.source, { line: m.line }) });
      if (onLink) {
        row.append(h('button.mini-button', { onclick: (e: MouseEvent) => { e.stopPropagation(); onLink(b.source, m.line); } }, 'Enlazar'));
      }
      out.append(row);
    }
  }
  return out;
}

export class BacklinksPanel extends ActivePanel {
  readonly id = 'backlinks';
  readonly title = 'Retroenlaces';
  readonly iconName = 'link';
  private showUnlinked = false;
  async refresh() {
    const path = this.current();
    if (!path) {
      this.el.replaceChildren(h('div.panel-empty', 'Abre una nota para ver sus retroenlaces.'));
      return;
    }
    const meta = await this.app.backend.meta(path);
    const names = [titleOf(path), ...(meta?.aliases ?? [])].map(fold);
    const linked = await this.app.backend.backlinks(path);
    const sections: HTMLElement[] = [h('div.panel-title', `Retroenlaces de «${titleOf(path)}»`), mentionList(this.app, linked, 'Menciones enlazadas', names)];
    const toggle = h('div.tree-item-title.is-header.clickable', { onclick: () => { this.showUnlinked = !this.showUnlinked; void this.refresh(); } }, h('span.nav-folder-collapse' + (this.showUnlinked ? '' : '.is-collapsed'), icon('chevron', 12)), 'Menciones sin enlazar');
    sections.push(toggle);
    if (this.showUnlinked) {
      const unlinked = await this.app.backend.unlinkedMentions(path);
      sections.push(mentionList(this.app, unlinked, '', names, (src, line) => void this.linkMention(src, line, path, meta?.aliases ?? [])));
    }
    if (this.current() === path) this.el.replaceChildren(...sections);
  }

  private async linkMention(source: string, line: number, target: string, aliases: string[]) {
    const content = await this.app.backend.read(source);
    const lines = content.split('\n');
    const title = titleOf(target);
    for (const name of [title, ...aliases]) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}\\[])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}\\]])`, 'iu');
      if (re.test(lines[line])) {
        lines[line] = lines[line].replace(re, (_m, pre, word) => `${pre}[[${title}${word === title ? '' : '|' + word}]]`);
        break;
      }
    }
    await this.app.writeFile(source, lines.join('\n'));
    for (const l of this.app.workspace.leaves()) l.view.onExternalChange([source]);
    this.invalidate();
  }
}

export class OutgoingPanel extends ActivePanel {
  readonly id = 'outgoing';
  readonly title = 'Enlaces salientes';
  readonly iconName = 'forward';
  async refresh() {
    const path = this.current();
    if (!path) {
      this.el.replaceChildren(h('div.panel-empty', 'Abre una nota.'));
      return;
    }
    const meta = await this.app.backend.meta(path);
    if (!meta) return;
    const seen = new Set<string>();
    const resolved: HTMLElement[] = [];
    const unresolved: HTMLElement[] = [];
    for (const l of meta.links) {
      const key = (l.resolved ?? '?' + l.target).toLowerCase();
      if (!l.target || seen.has(key)) continue;
      seen.add(key);
      if (l.resolved) {
        const r = l.resolved;
        resolved.push(h('div.tree-item-title', { onclick: (e: MouseEvent) => void this.app.open(r, { newLeaf: e.ctrlKey || e.metaKey }) }, icon(isNote(r) ? 'file' : 'image', 13), ' ', titleOf(r)));
      } else {
        unresolved.push(h('div.tree-item-title.is-unresolved', { title: 'Clic para crear', onclick: () => void this.app.openLinkText(l.target, path) }, icon('plus', 13), ' ', l.target));
      }
    }
    this.el.replaceChildren(
      h('div.panel-title', `Enlaces salientes de «${titleOf(path)}»`),
      h('div.tree-item-title.is-header', 'Enlaces', h('span.tree-count', String(resolved.length))),
      ...resolved,
      h('div.tree-item-title.is-header', 'Sin resolver', h('span.tree-count', String(unresolved.length))),
      ...unresolved,
    );
  }
}

export class OutlinePanel extends ActivePanel {
  readonly id = 'outline';
  readonly title = 'Esquema';
  readonly iconName = 'list';
  async refresh() {
    const path = this.current();
    const meta = path ? await this.app.backend.meta(path) : null;
    if (!path || !meta) {
      this.el.replaceChildren(h('div.panel-empty', 'Abre una nota para ver su esquema.'));
      return;
    }
    const min = Math.min(...meta.headings.map((x) => x.level), 6);
    const items = meta.headings.map((hd) =>
      h('div.outline-item', {
        style: { paddingLeft: 8 + (hd.level - min) * 14 + 'px' },
        onclick: () => {
          const v = this.app.workspace.activeLeaf()?.view;
          if (v instanceof MarkdownView && v.file === path) v.scrollToLine(hd.line);
          else void this.app.open(path, { line: hd.line });
        },
      }, hd.text),
    );
    const props = meta.frontmatter && Object.keys(meta.frontmatter).length
      ? [h('div.tree-item-title.is-header', 'Propiedades'), ...Object.entries(meta.frontmatter).map(([k, v]) => h('div.property-row', h('span.property-key', k), h('span.property-value', { html: escapeHtml(Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)) })))]
      : [];
    const stats = h('div.outline-stats', `${meta.wordCount} palabras · ${meta.charCount} caracteres · ${meta.links.length} enlaces · ${meta.backlinkCount} retroenlaces`);
    this.el.replaceChildren(h('div.panel-title', 'Esquema'), ...(items.length ? items : [h('div.panel-empty', 'Sin encabezados.')]), ...props, stats);
  }
}

export class LocalGraphPanel extends ActivePanel {
  readonly id = 'local-graph';
  readonly title = 'Grafo local';
  readonly iconName = 'graph';
  private renderer: GraphRenderer | null = null;
  private depth = 1;
  private host = h('div.local-graph-host');
  constructor(app: App) {
    super(app);
    const depth = h('input', { type: 'range', min: '1', max: '4', step: '1', value: '1' }) as HTMLInputElement;
    depth.addEventListener('input', () => {
      this.depth = Number(depth.value);
      this.invalidate();
    });
    this.el.append(h('div.panel-title', 'Grafo local'), h('label.graph-control-row.slider', h('span', 'Profundidad'), depth), this.host);
  }
  async refresh() {
    const path = this.current();
    if (!this.renderer) {
      this.renderer = new GraphRenderer(this.host, (id, newTab) => {
        if (id.startsWith('tag:')) this.app.searchFor(`tag:#${id.slice(4)}`);
        else if (!id.startsWith('unresolved:')) void this.app.open(id, { newLeaf: newTab });
      });
      this.app.events.on('settings', () => this.renderer?.readColors());
    }
    if (!path) return this.renderer.setData({ nodes: [], edges: [] });
    const g = await this.app.backend.localGraph(path, this.depth, { tags: false, attachments: false });
    this.renderer.activeId = path;
    this.renderer.setData(g);
  }
}
