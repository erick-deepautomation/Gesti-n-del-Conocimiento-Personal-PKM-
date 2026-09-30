import './styles.css';
import type { Backend, VaultInfo } from './backend/types';
import { App } from './core/app';
import { prettyHotkey } from './core/commands';
import { PluginManager } from './core/plugins';
import { basename, dirname, formatDate, h, icon, iconButton, isMobile, isNote, titleOf } from './core/util';
import { insertAtCursor, toggleTaskAtCursor, toggleWrap } from './editor/editor';
import { renderToHtmlString } from './render/markdown';
import { SuggestModal, fuzzyFilter, notice, showMenu, type MenuItem } from './ui/modals';
import {
  BacklinksPanel, BookmarksPanel, FileExplorer, LocalGraphPanel, OutgoingPanel, OutlinePanel, SearchPanel, Sidebar, TagsPanel, TasksPanel,
} from './ui/panels';
import { openSettings } from './ui/settings-modal';
import type { Leaf } from './ui/workspace';
import { EmptyView, FileView } from './views/basic';
import { CanvasView } from './views/canvas';
import { GraphView } from './views/graph';
import { MarkdownView } from './views/markdown';
import { foldAll, unfoldAll } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import { undo } from '@codemirror/commands';

// Pinta el tema antes de cargar nada (evita parpadeo).
document.body.classList.add(localStorage.getItem('nexo.theme') === 'light' ? 'theme-light' : 'theme-dark');
if (isMobile) document.body.classList.add('is-mobile');

async function pickBackend(): Promise<Backend> {
  if ('__TAURI_INTERNALS__' in window) {
    const { TauriBackend } = await import('./backend/tauri');
    return new TauriBackend();
  }
  const { WebBackend } = await import('./backend/web');
  return new WebBackend();
}

const root = document.getElementById('app')!;

async function boot() {
  root.replaceChildren(h('div.loading', h('div.loading-spinner'), 'Cargando…'));
  const backend = await pickBackend();
  let info: VaultInfo | null = null;
  try {
    info = await backend.init();
  } catch (e) {
    console.error(e);
  }
  if (!info) info = await welcome(backend);
  await start(backend, info);
}

function welcome(backend: Backend): Promise<VaultInfo> {
  return new Promise((resolve) => {
    const err = h('div.welcome-error');
    const options = backend.openModes().map((m) =>
      h('button.welcome-option', {
        onclick: async () => {
          err.textContent = '';
          try {
            const info = await backend.openVault(m.id);
            if (info) resolve(info);
          } catch (e) {
            err.textContent = String(e);
          }
        },
      }, h('div.welcome-option-title', m.label), h('div.welcome-option-hint', m.hint)),
    );
    const logo = h('img.welcome-logo', { src: './icon.svg', alt: '' });
    root.replaceChildren(
      h('div.welcome',
        h('div.welcome-card', logo, h('h1', 'Nexo PKM'), h('p.welcome-sub', 'Tu segundo cerebro: Markdown plano, enlaces bidireccionales, grafo y búsqueda instantánea.'), ...options, err),
      ),
    );
  });
}

async function start(backend: Backend, info: VaultInfo) {
  const app = new App(backend);
  (window as any).nexo = app; // útil para depurar y para complementos
  const ws = app.workspace;
  ws.factories = {
    markdown: (a) => new MarkdownView(a),
    canvas: (a) => new CanvasView(a),
    graph: (a) => new GraphView(a),
    file: (a) => new FileView(a),
    empty: (a) => new EmptyView(a),
  };
  ws.init();

  // ---------------------------------------------------------------- layout
  const search = new SearchPanel(app);
  const left = new Sidebar('left', [new FileExplorer(app), search, new BookmarksPanel(app), new TagsPanel(app), new TasksPanel(app)]);
  const right = new Sidebar('right', [new BacklinksPanel(app), new OutgoingPanel(app), new OutlinePanel(app), new LocalGraphPanel(app)]);
  const ribbon = h('div.ribbon');
  const statusBar = h('div.status-bar');
  const plugins = new PluginManager(app, () => ribbon, () => statusBar);

  const ribbonBtn = (name: string, title: string, cmd: string) => iconButton(name, title, () => void app.commands.run(cmd), 'ribbon-button');
  ribbon.append(
    ribbonBtn('sidebarLeft', 'Barra lateral izquierda', 'sidebar:left'),
    ribbonBtn('search', 'Selector rápido', 'switcher:open'),
    ribbonBtn('graph', 'Vista de grafo', 'graph:open'),
    ribbonBtn('calendar', 'Nota diaria de hoy', 'daily:today'),
    ribbonBtn('canvas', 'Nuevo lienzo', 'file:new-canvas'),
    ribbonBtn('template', 'Insertar plantilla', 'template:insert'),
    ribbonBtn('random', 'Nota aleatoria', 'file:random'),
    ribbonBtn('command', 'Paleta de comandos', 'palette:open'),
    h('div.ribbon-spacer'),
    ribbonBtn('vault', 'Cambiar de bóveda', 'vault:switch'),
    ribbonBtn('settings', 'Ajustes', 'settings:open'),
  );

  const mobileBar = h('div.mobile-bar',
    iconButton('menu', 'Archivos', () => toggleMobile('left')),
    h('div.mobile-title'),
    iconButton('search', 'Buscar', () => void app.commands.run('switcher:open')),
    iconButton('command', 'Comandos', () => void app.commands.run('palette:open')),
    iconButton('sidebarRight', 'Panel derecho', () => toggleMobile('right')),
  );
  const mobileTools = h('div.mobile-toolbar',
    ...([
      ['[[ ]]', () => withEditor((v) => toggleWrap(v, '[[', ']]'))],
      ['#', () => withEditor((v) => insertAtCursor(v, '#'))],
      ['B', () => withEditor((v) => toggleWrap(v, '**'))],
      ['I', () => withEditor((v) => toggleWrap(v, '*'))],
      ['@check', () => withEditor((v) => toggleTaskAtCursor(v))],
      ['H', () => withEditor((v) => { const l = v.state.doc.lineAt(v.state.selection.main.head); v.dispatch({ changes: { from: l.from, insert: '#' + (l.text.startsWith('#') ? '' : ' ') } }); })],
      ['@back', () => void app.commands.run('editor:undo')],
      ['@eye', () => void app.commands.run('editor:toggle-mode')],
    ] as [string, () => void][]).map(([label, fn]) => h('button.mobile-tool', { onmousedown: (e: MouseEvent) => { e.preventDefault(); fn(); } }, label.startsWith('@') ? icon(label.slice(1)) : label)),
  );
  const scrim = h('div.mobile-scrim', { onclick: () => document.body.classList.remove('left-open-mobile', 'right-open-mobile') });
  const toggleMobile = (side: 'left' | 'right') => {
    const cls = `${side}-open-mobile`;
    const on = !document.body.classList.contains(cls);
    document.body.classList.remove('left-open-mobile', 'right-open-mobile');
    if (on) {
      document.body.classList.add(cls);
      (side === 'left' ? left : right).active?.show();
    }
  };

  root.replaceChildren(
    h('div.app-container', mobileBar, h('div.app-main', ribbon, left.el, h('div.workspace-root', ws.el), right.el), statusBar, mobileTools, scrim),
  );
  if (localStorage.getItem('nexo.left.collapsed') === '1') left.toggle(false);
  else left.toggle(true);
  if (localStorage.getItem('nexo.right.collapsed') === '1' || window.innerWidth < 1000) right.toggle(false);
  else right.toggle(true);

  const activeMd = (): MarkdownView | null => {
    const v = ws.activeLeaf()?.view;
    return v instanceof MarkdownView ? v : null;
  };
  function withEditor(fn: (v: MarkdownView['editor']['view']) => unknown) {
    const md = activeMd();
    if (md && md.mode === 'edit') fn(md.editor.view);
  }

  // ---------------------------------------------------------------- cabecera de vista y barra de estado
  const statusWords = h('div.status-bar-item');
  const statusLinks = h('div.status-bar-item');
  const statusVault = h('div.status-bar-item.mod-clickable', { onclick: () => void app.commands.run('vault:switch') });
  statusBar.append(statusLinks, statusWords, statusVault);

  const updateStatus = async () => {
    const p = app.activePath();
    statusVault.textContent = `${app.vault?.name ?? ''} · ${app.files.filter((f) => f.isNote).length} notas`;
    if (p && isNote(p)) {
      const meta = await backend.meta(p);
      statusWords.textContent = meta ? `${meta.wordCount.toLocaleString()} palabras · ${meta.charCount.toLocaleString()} caracteres` : '';
      statusLinks.textContent = meta ? `${meta.backlinkCount} retroenlaces` : '';
    } else {
      statusWords.textContent = '';
      statusLinks.textContent = '';
    }
  };
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const updateStatusSoon = () => {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => void updateStatus(), 300);
  };
  app.events.on('modified', updateStatusSoon);
  app.events.on('files-changed', updateStatusSoon);

  ws.onHeader = (leaf: Leaf) => renderHeader(leaf);
  ws.onActiveChange = (leaf) => {
    const path = leaf?.view.path() ?? null;
    app.events.emit('active-changed', { path, leaf });
    updateStatusSoon();
    document.title = path ? `${titleOf(path)} — Nexo` : 'Nexo PKM';
    (mobileBar.querySelector('.mobile-title') as HTMLElement).textContent = path ? titleOf(path) : app.vault?.name ?? '';
    document.body.classList.toggle('is-editing', !!(leaf?.view instanceof MarkdownView && leaf.view.mode === 'edit'));
  };

  function renderHeader(leaf: Leaf) {
    const v = leaf.view;
    const path = v.path();
    const crumbs = h('div.view-header-title');
    if (path) {
      const dir = dirname(path);
      if (dir) crumbs.append(h('span.view-header-breadcrumb', { onclick: () => app.events.emit('reveal-file', { path }) }, dir.split('/').join(' / ')), h('span.view-header-sep', ' / '));
      crumbs.append(h('span.view-header-name', v.title()));
    } else crumbs.append(h('span.view-header-name', v.title()));
    const actions = h('div.view-actions');
    if (v instanceof MarkdownView) {
      actions.append(
        iconButton(v.mode === 'edit' ? 'eye' : 'edit', v.mode === 'edit' ? 'Modo lectura (Ctrl+E)' : 'Editar (Ctrl+E)', () => void app.commands.run('editor:toggle-mode')),
      );
    }
    if (path) actions.append(iconButton('more', 'Más opciones', (e) => fileMenu(path, e)));
    const back = iconButton('back', 'Atrás', () => void leaf.back(), 'clickable-icon');
    const fwd = iconButton('forward', 'Adelante', () => void leaf.forward(), 'clickable-icon');
    back.classList.toggle('is-disabled', !leaf.canBack());
    fwd.classList.toggle('is-disabled', !leaf.canForward());
    leaf.pane.viewHeader.replaceChildren(h('div.view-header-nav', back, fwd), crumbs, actions);
    document.body.classList.toggle('is-editing', v instanceof MarkdownView && v.mode === 'edit');
  }

  function fileMenu(path: string, e: MouseEvent) {
    const items: MenuItem[] = [
      { title: 'Abrir a la derecha', onClick: () => void app.open(path, { newLeaf: 'split' }) },
      { title: app.bookmarks.includes(path) ? 'Quitar marcador' : 'Añadir marcador', onClick: () => app.toggleBookmark(path) },
      { title: 'Revelar en el explorador', onClick: () => { left.toggle(true); left.activate('files'); app.events.emit('reveal-file', { path }); } },
      { title: 'Copiar enlace', onClick: () => void navigator.clipboard.writeText(`[[${titleOf(path)}]]`) },
      { separator: true, title: '' },
      { title: 'Renombrar…', onClick: () => void app.promptRename(path) },
      { title: 'Mover a…', onClick: () => void app.commands.run('file:move') },
    ];
    if (isNote(path)) items.push({ title: 'Exportar a PDF', onClick: () => void app.commands.run('export:pdf') }, { title: 'Exportar a HTML', onClick: () => void app.commands.run('export:html') });
    items.push({ separator: true, title: '' }, { title: 'Eliminar', danger: true, onClick: () => void app.delete(path) });
    showMenu(items, e.clientX, e.clientY);
  }

  // ---------------------------------------------------------------- comandos
  const C = app.commands;
  C.register({ id: 'palette:open', name: 'Abrir paleta de comandos', hotkey: 'Mod+P', run: () => openPalette() });
  C.register({ id: 'switcher:open', name: 'Selector rápido: abrir archivo', hotkey: 'Mod+O', run: () => openSwitcher() });
  C.register({ id: 'file:new-note', name: 'Crear nota nueva', hotkey: 'Mod+N', run: () => app.createNote() });
  C.register({ id: 'file:new-note-split', name: 'Crear nota nueva a la derecha', run: async () => { const p = await app.createNote(undefined, undefined, '', false); await app.open(p, { newLeaf: 'split' }); } });
  C.register({ id: 'file:new-canvas', name: 'Crear lienzo nuevo', run: () => app.createCanvas() });
  C.register({ id: 'file:new-folder', name: 'Crear carpeta nueva', run: () => app.createFolder(app.newNoteFolder(app.activePath())) });
  const hasFile = () => !!app.activePath();
  C.register({ id: 'file:rename', name: 'Renombrar archivo', hotkey: 'F2', when: hasFile, run: () => app.promptRename(app.activePath()!) });
  C.register({ id: 'file:delete', name: 'Eliminar archivo actual', when: hasFile, run: () => app.delete(app.activePath()!) });
  C.register({ id: 'file:bookmark', name: 'Añadir/quitar marcador', hotkey: 'Mod+Shift+B', when: hasFile, run: () => app.toggleBookmark(app.activePath()!) });
  C.register({ id: 'file:reveal', name: 'Revelar archivo activo en el explorador', when: hasFile, run: () => { left.toggle(true); left.activate('files'); app.events.emit('reveal-file', { path: app.activePath()! }); } });
  C.register({ id: 'file:copy-link', name: 'Copiar enlace a la nota', when: hasFile, run: () => navigator.clipboard.writeText(`[[${titleOf(app.activePath()!)}]]`) });
  C.register({ id: 'file:random', name: 'Abrir nota aleatoria', run: () => { const notes = app.files.filter((f) => f.isNote); if (notes.length) void app.open(notes[Math.floor(Math.random() * notes.length)].path); } });
  C.register({
    id: 'file:move', name: 'Mover archivo a otra carpeta', when: hasFile,
    run: () => {
      const path = app.activePath()!;
      new SuggestModal<string>('Carpeta destino…', (q) => fuzzyFilter(['', ...[...app.folders].sort()], q, (f) => f || '/').map(({ item, html }) => ({ value: item, title: item || '/', html })), (it) => it && void app.move(path, it.value)).open();
    },
  });
  C.register({ id: 'search:vault', name: 'Buscar en toda la bóveda', hotkey: 'Mod+Shift+F', run: () => { left.toggle(true); left.activate('search'); search.input.focus(); search.input.select(); if (isMobile) toggleMobile('left'); } });
  C.register({ id: 'search:note', name: 'Buscar y reemplazar en la nota', when: () => !!activeMd(), run: () => { const md = activeMd()!; if (md.mode === 'read') void md.setMode('edit'); openSearchPanel(md.editor.view); } });
  C.register({ id: 'editor:toggle-mode', name: 'Alternar edición / lectura', hotkey: 'Mod+E', when: () => !!activeMd(), run: async () => { await activeMd()!.toggleMode(); const l = ws.activeLeaf(); if (l) renderHeader(l); } });
  C.register({ id: 'editor:toggle-live', name: 'Alternar vista previa en vivo / modo fuente', run: () => app.updateSettings({ livePreview: !app.settings.livePreview }) });
  C.register({ id: 'editor:fold-all', name: 'Plegar todo', when: () => !!activeMd(), run: () => foldAll(activeMd()!.editor.view) });
  C.register({ id: 'editor:unfold-all', name: 'Desplegar todo', when: () => !!activeMd(), run: () => unfoldAll(activeMd()!.editor.view) });
  C.register({ id: 'editor:undo', name: 'Deshacer', when: () => !!activeMd(), run: () => undo(activeMd()!.editor.view) });
  C.register({ id: 'editor:toggle-task', name: 'Alternar casilla de tarea', when: () => !!activeMd(), run: () => withEditor(toggleTaskAtCursor) });
  C.register({ id: 'insert:date', name: 'Insertar fecha actual', when: () => !!activeMd(), run: () => withEditor((v) => insertAtCursor(v, formatDate(new Date(), app.settings.dateFormat))) });
  C.register({ id: 'insert:time', name: 'Insertar hora actual', when: () => !!activeMd(), run: () => withEditor((v) => insertAtCursor(v, formatDate(new Date(), app.settings.timeFormat))) });
  C.register({ id: 'template:insert', name: 'Insertar plantilla', hotkey: 'Alt+T', run: () => insertTemplate() });
  C.register({ id: 'graph:open', name: 'Abrir vista de grafo', hotkey: 'Mod+G', run: () => ws.openState({ type: 'graph', state: {} }, { newLeaf: ws.activeLeaf()?.view.type !== 'empty' }) });
  C.register({ id: 'graph:local', name: 'Mostrar grafo local', run: () => { right.toggle(true); right.activate('local-graph'); } });
  C.register({ id: 'panel:backlinks', name: 'Mostrar retroenlaces', run: () => { right.toggle(true); right.activate('backlinks'); } });
  C.register({ id: 'panel:outline', name: 'Mostrar esquema', run: () => { right.toggle(true); right.activate('outline'); } });
  C.register({ id: 'panel:tags', name: 'Mostrar etiquetas', run: () => { left.toggle(true); left.activate('tags'); } });
  C.register({ id: 'panel:tasks', name: 'Mostrar tareas de la bóveda', run: () => { left.toggle(true); left.activate('tasks'); } });
  C.register({ id: 'panel:bookmarks', name: 'Mostrar marcadores', run: () => { left.toggle(true); left.activate('bookmarks'); } });
  C.register({ id: 'panel:files', name: 'Mostrar explorador de archivos', hotkey: 'Mod+Shift+E', run: () => { left.toggle(true); left.activate('files'); } });
  C.register({ id: 'daily:today', name: 'Abrir nota diaria de hoy', hotkey: 'Mod+Shift+D', run: () => app.dailyNote(0) });
  C.register({ id: 'daily:prev', name: 'Nota diaria anterior', run: () => app.adjacentDaily(-1) });
  C.register({ id: 'daily:next', name: 'Nota diaria siguiente', run: () => app.adjacentDaily(1) });
  C.register({ id: 'tab:new', name: 'Nueva pestaña', hotkey: 'Mod+T', run: () => ws.openState({ type: 'empty', state: {} }, { newLeaf: true }) });
  C.register({ id: 'tab:close', name: 'Cerrar pestaña actual', hotkey: 'Mod+W', when: () => !!ws.activeLeaf(), run: () => ws.closeLeaf(ws.activeLeaf()!) });
  C.register({ id: 'pane:split', name: 'Dividir a la derecha', hotkey: 'Mod+\\', run: () => { const l = ws.activeLeaf(); if (l) void ws.openState(l.getViewState(), { newLeaf: 'split' }); } });
  C.register({ id: 'nav:back', name: 'Navegar atrás', hotkey: 'Mod+Alt+ArrowLeft', run: () => ws.activeLeaf()?.back() });
  C.register({ id: 'nav:forward', name: 'Navegar adelante', hotkey: 'Mod+Alt+ArrowRight', run: () => ws.activeLeaf()?.forward() });
  C.register({ id: 'sidebar:left', name: 'Alternar barra lateral izquierda', run: () => { if (isMobile) return toggleMobile('left'); left.toggle(); localStorage.setItem('nexo.left.collapsed', left.isOpen() ? '0' : '1'); } });
  C.register({ id: 'sidebar:right', name: 'Alternar barra lateral derecha', run: () => { if (isMobile) return toggleMobile('right'); right.toggle(); localStorage.setItem('nexo.right.collapsed', right.isOpen() ? '0' : '1'); } });
  C.register({ id: 'theme:toggle', name: 'Alternar tema claro/oscuro', run: () => app.updateSettings({ theme: document.body.classList.contains('theme-dark') ? 'light' : 'dark' }) });
  C.register({ id: 'settings:open', name: 'Abrir ajustes', hotkey: 'Mod+,', run: () => openSettings(app, plugins) });
  C.register({ id: 'vault:switch', name: 'Abrir otra bóveda', run: async () => { for (const l of ws.leaves()) await l.view.beforeLeave(); const i = await welcome(backend); location.hash = ''; void i; location.reload(); } });
  C.register({ id: 'vault:unresolved', name: 'Ver enlaces sin resolver', run: () => openUnresolved() });
  C.register({ id: 'vault:stats', name: 'Estadísticas de la bóveda', run: async () => { const s = await backend.stats(); notice(`${s.notes} notas · ${s.files} archivos · ${s.links} enlaces · ${s.words.toLocaleString()} palabras`, 6000); } });
  C.register({ id: 'export:pdf', name: 'Exportar nota a PDF (imprimir)', when: () => !!activeMd(), run: async () => { const md = activeMd()!; const prev = md.mode; await md.setMode('read'); document.body.classList.add('is-printing'); window.print(); document.body.classList.remove('is-printing'); if (prev === 'edit') await md.setMode('edit'); } });
  C.register({
    id: 'export:html', name: 'Exportar nota a HTML', when: () => !!activeMd(),
    run: () => {
      const md = activeMd()!;
      const title = md.title();
      const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"><style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.6 system-ui,sans-serif;color:#222}pre{background:#f5f5f5;padding:12px;overflow:auto}blockquote{border-left:3px solid #8b5cf6;margin:0;padding-left:12px;color:#555}mark{background:#fff3a3}img{max-width:100%}</style></head><body><h1>${title}</h1>${renderToHtmlString(md.content())}</body></html>`;
      const a = h('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `${title}.html` }) as HTMLAnchorElement;
      a.click();
    },
  });

  function openPalette() {
    const m = new SuggestModal(
      'Escribe un comando…',
      (q) =>
        fuzzyFilter(C.list(), q, (c) => c.name).map(({ item, html }) => {
          const hk = C.hotkeyOf(item.id);
          return { value: item.id, title: item.name, html, aux: hk ? prettyHotkey(hk) : undefined };
        }),
      (it) => it && void C.run(it.value),
    );
    m.open();
  }

  function openSwitcher() {
    const m = new SuggestModal<string>(
      'Busca un archivo o escribe para crear…',
      async (q) => {
        const hits = await backend.quickSwitch(q, 50);
        const items = hits.map((x) => ({ value: x.path, title: x.alias ? `${x.alias}` : x.title, note: x.alias ? `→ ${x.path}` : dirname(x.path) || undefined, aux: x.isNote ? undefined : basename(x.path).split('.').pop()?.toUpperCase() }));
        if (!q.trim()) {
          // Recientes primero.
          const rec = app.recent.filter((p) => app.resolver.exists(p)).slice(0, 12);
          return [...rec.map((p) => ({ value: p, title: titleOf(p), note: dirname(p) || undefined, aux: 'reciente' })), ...items.filter((i) => !rec.includes(i.value))].slice(0, 50);
        }
        return items;
      },
      async (it, q, e) => {
        const newLeaf = e.ctrlKey || e.metaKey;
        if (it && !e.shiftKey) await app.open(it.value, { newLeaf });
        else if (q.trim()) await app.openLinkText(q.trim(), app.activePath() ?? '', { newLeaf });
      },
    );
    m.emptyText = (q) => (q.trim() ? `Pulsa Intro para crear «${q.trim()}»` : 'Sin archivos');
    m.instructions = [['↵', 'abrir'], [`${prettyHotkey('Mod')}+↵`, 'en pestaña nueva'], ['⇧+↵', 'crear'], ['esc', 'cerrar']];
    m.open();
  }

  function insertTemplate() {
    const md = activeMd();
    if (!md) return notice('Abre una nota para insertar una plantilla');
    const tpls = app.templates();
    if (!tpls.length) return notice(`No hay plantillas en «${app.settings.templatesFolder}»`);
    new SuggestModal<string>('Elige una plantilla…', (q) => fuzzyFilter(tpls, q, titleOf).map(({ item, html }) => ({ value: item, title: titleOf(item), html })), async (it) => {
      if (!it) return;
      const tpl = app.applyTemplate(await backend.read(it.value), md.title());
      if (md.mode === 'read') await md.setMode('edit');
      insertAtCursor(md.editor.view, tpl);
    }).open();
  }

  async function openUnresolved() {
    const list = await backend.unresolved();
    new SuggestModal<string>('Enlaces sin resolver (Intro para crear la nota)…', (q) =>
      fuzzyFilter(list, q, (u) => u.target).map(({ item, html }) => ({ value: item.target, title: item.target, html, note: `${item.count} referencia(s) en ${item.sources.map(titleOf).join(', ')}` })),
    (it) => it && void app.openLinkText(it.value, list.find((u) => u.target === it.value)?.sources[0] ?? '')).open();
  }

  // ---------------------------------------------------------------- eventos globales
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || document.querySelector('.modal-bg')) return;
    C.handleKey(e);
  });
  app.events.on('search-request', ({ query }) => {
    if (isMobile) toggleMobile('left');
    else left.toggle(true);
    (left.activate('search') as SearchPanel).setQuery(query);
  });
  app.events.on('settings', () => { const l = ws.activeLeaf(); if (l) renderHeader(l); });
  window.addEventListener('beforeunload', () => {
    for (const l of ws.leaves()) void l.view.beforeLeave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const l of ws.leaves()) void l.view.beforeLeave();
  });

  // ---------------------------------------------------------------- arranque
  await app.loadVault(info);
  let restored = false;
  try {
    const raw = await backend.readConfig('workspace.json');
    if (raw) {
      await ws.restore(JSON.parse(raw));
      restored = ws.leaves().some((l) => l.view.type !== 'empty');
    }
  } catch {
    /* espacio de trabajo nuevo */
  }
  if (!ws.leaves().length) await ws.openState({ type: 'empty', state: {} });
  if (!restored) {
    const welcomeNote = app.resolver.resolve('Bienvenida', '') ?? app.files.find((f) => f.isNote)?.path;
    if (welcomeNote) await app.open(welcomeNote);
  }
  await plugins.loadEnabled();
  void updateStatus();
  notice(`Bóveda «${info.name}» indexada: ${info.stats.notes} notas en ${info.elapsedMs} ms`);

  if (backend.kind === 'web' && import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

void boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('div.welcome', h('div.welcome-card', icon('x', 32), h('h2', 'Error al iniciar'), h('pre', String(e?.stack ?? e)))));
});
