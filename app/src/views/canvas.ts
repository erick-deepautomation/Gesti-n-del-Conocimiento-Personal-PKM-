// Editor de lienzos compatible con JSON Canvas 1.0 (formato .canvas de Obsidian).
import type { App } from '../core/app';
import { IMAGE_EXT, debounce, extname, h, iconButton, titleOf } from '../core/util';
import { renderMarkdown, splitFrontmatter } from '../render/markdown';
import { attachLinkHandlers } from '../ui/links';
import { SuggestModal, notice } from '../ui/modals';
import { View } from '../ui/workspace';

type Side = 'top' | 'right' | 'bottom' | 'left';

interface CNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

interface CEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  toNode: string;
  toSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
}

interface CanvasData {
  nodes: CNode[];
  edges: CEdge[];
  [k: string]: unknown;
}

const uid = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
const SVGNS = 'http://www.w3.org/2000/svg';
const PRESET = ['', '#fb464c', '#e9973f', '#e0de71', '#44cf6e', '#53dfdd', '#a882ff'];
const colorOf = (c?: string) => (!c ? '' : /^\d$/.test(c) ? PRESET[Number(c)] ?? '' : c);

function anchor(n: CNode, side: Side) {
  switch (side) {
    case 'top': return { x: n.x + n.width / 2, y: n.y };
    case 'bottom': return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left': return { x: n.x, y: n.y + n.height / 2 };
    case 'right': return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

function bestSides(a: CNode, b: CNode): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

const normal = (s: Side) => ({ top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } })[s];

export class CanvasView extends View {
  readonly type = 'canvas';
  file: string | null = null;
  private data: CanvasData = { nodes: [], edges: [] };
  private world: HTMLElement;
  private svg: SVGSVGElement;
  private wrapper: HTMLElement;
  private nodeEls = new Map<string, HTMLElement>();
  private t = { x: 0, y: 0, k: 1 };
  private selected: { kind: 'node' | 'edge'; id: string } | null = null;
  private editing: string | null = null;
  private tempLine: SVGPathElement | null = null;
  private save = debounce(() => void this.flush(), 500);
  private dirty = false;

  constructor(app: App) {
    super(app);
    this.el.classList.add('canvas-view');
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    this.svg.classList.add('canvas-edges');
    this.svg.innerHTML = `<defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs>`;
    this.world = h('div.canvas-world');
    this.world.append(this.svg);
    this.wrapper = h('div.canvas-wrapper', { tabindex: '0' }, this.world);
    const toolbar = h('div.canvas-toolbar',
      iconButton('plus', 'Añadir tarjeta de texto', () => this.addText(this.center())),
      iconButton('file', 'Añadir nota o archivo', () => this.pickFile(this.center())),
      iconButton('canvas', 'Añadir grupo', () => this.addNode({ type: 'group', label: 'Grupo', ...this.center(), width: 400, height: 300 })),
      iconButton('collapse', 'Ajustar a la vista', () => this.zoomToFit()),
    );
    this.el.append(this.wrapper, toolbar, h('div.canvas-hint', 'Doble clic: nueva tarjeta · Arrastra desde los bordes para conectar · Supr: eliminar'));
    this.bind();
  }

  title() {
    return this.file ? titleOf(this.file).replace(/\.canvas$/, '') : 'Lienzo';
  }
  icon() {
    return 'canvas';
  }
  path() {
    return this.file;
  }
  getState() {
    return { path: this.file };
  }

  async setState(st: Record<string, any>) {
    await this.flush();
    this.file = st.path;
    try {
      const raw = await this.app.backend.read(this.file!);
      const d = raw.trim() ? JSON.parse(raw) : {};
      this.data = { ...d, nodes: d.nodes ?? [], edges: d.edges ?? [] };
    } catch {
      notice('Lienzo no válido; se abrirá vacío');
      this.data = { nodes: [], edges: [] };
    }
    this.renderAll();
    requestAnimationFrame(() => this.zoomToFit());
    this.updateTitle();
  }

  private changed() {
    this.dirty = true;
    this.save();
  }

  async flush() {
    this.save.cancel();
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    await this.app.writeFile(this.file, JSON.stringify(this.data, null, '\t'));
  }

  async beforeLeave() {
    await this.flush();
  }

  destroy() {
    void this.flush();
  }

  onRename(o: string, n: string) {
    if (this.file === o) {
      this.file = n;
      this.updateTitle();
    }
    let touched = false;
    for (const node of this.data.nodes) {
      if (node.file === o) {
        node.file = n;
        touched = true;
      }
    }
    if (touched) {
      this.changed();
      this.renderAll();
    }
  }

  // ------------------------------------------------------------ geometría

  private applyTransform() {
    this.world.style.transform = `translate(${this.t.x}px, ${this.t.y}px) scale(${this.t.k})`;
    this.wrapper.style.backgroundSize = `${24 * this.t.k}px ${24 * this.t.k}px`;
    this.wrapper.style.backgroundPosition = `${this.t.x}px ${this.t.y}px`;
  }

  private toWorld(clientX: number, clientY: number) {
    const r = this.wrapper.getBoundingClientRect();
    return { x: (clientX - r.left - this.t.x) / this.t.k, y: (clientY - r.top - this.t.y) / this.t.k };
  }

  private center() {
    const r = this.wrapper.getBoundingClientRect();
    const c = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    return { x: Math.round(c.x - 130), y: Math.round(c.y - 60) };
  }

  zoomToFit() {
    const r = this.wrapper.getBoundingClientRect();
    if (!this.data.nodes.length || !r.width) {
      this.t = { x: r.width / 2, y: r.height / 2, k: 1 };
      return this.applyTransform();
    }
    const minX = Math.min(...this.data.nodes.map((n) => n.x));
    const minY = Math.min(...this.data.nodes.map((n) => n.y));
    const maxX = Math.max(...this.data.nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...this.data.nodes.map((n) => n.y + n.height));
    const k = Math.min(1.5, Math.max(0.1, Math.min((r.width - 80) / (maxX - minX || 1), (r.height - 80) / (maxY - minY || 1))));
    this.t = { k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 - ((minY + maxY) / 2) * k };
    this.applyTransform();
  }

  // ------------------------------------------------------------ render

  private renderAll() {
    this.world.querySelectorAll('.canvas-node').forEach((e) => e.remove());
    this.nodeEls.clear();
    // Grupos primero (debajo).
    const sorted = [...this.data.nodes].sort((a, b) => (a.type === 'group' ? -1 : 0) - (b.type === 'group' ? -1 : 0));
    for (const n of sorted) this.renderNode(n);
    this.renderEdges();
    this.applyTransform();
  }

  private renderNode(n: CNode) {
    const el = h('div.canvas-node.canvas-node-' + n.type, { dataset: { id: n.id } });
    const color = colorOf(n.color);
    if (color) el.style.setProperty('--canvas-color', color);
    const content = h('div.canvas-node-content');
    el.append(content);
    for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) el.append(h('div.canvas-handle.canvas-handle-' + side, { dataset: { side } }));
    el.append(h('div.canvas-resize'));
    this.positionNode(el, n);
    this.world.append(el);
    this.nodeEls.set(n.id, el);
    void this.fillContent(n, content);
    if (this.selected?.kind === 'node' && this.selected.id === n.id) el.classList.add('is-selected');
  }

  private async fillContent(n: CNode, content: HTMLElement) {
    content.replaceChildren();
    if (n.type === 'text') {
      await renderMarkdown(this.app, content, n.text ?? '', { sourcePath: this.file ?? '' });
      attachLinkHandlers(this.app, content, () => this.file ?? '');
    } else if (n.type === 'group') {
      content.append(h('div.canvas-group-label', n.label ?? ''));
    } else if (n.type === 'link') {
      content.append(h('a.external-link', { href: n.url, target: '_blank', rel: 'noopener' }, n.url ?? ''));
    } else if (n.type === 'file' && n.file) {
      const path = this.app.resolver.resolve(n.file, '') ?? n.file;
      const header = h('div.canvas-file-title', { onclick: () => void this.app.open(path, { newLeaf: true }) }, titleOf(path));
      content.append(header);
      if (IMAGE_EXT.has(extname(path))) {
        content.append(h('img', { src: await this.app.backend.resourceUrl(path), draggable: 'false' }));
      } else if (extname(path) === 'md') {
        const body = h('div.canvas-file-body');
        content.append(body);
        try {
          const text = splitFrontmatter(await this.app.backend.read(path)).body;
          await renderMarkdown(this.app, body, text.slice(0, 8000), { sourcePath: path, depth: 1 });
          attachLinkHandlers(this.app, body, () => path);
        } catch {
          body.textContent = 'Archivo no encontrado';
        }
      }
    }
  }

  private positionNode(el: HTMLElement, n: CNode) {
    Object.assign(el.style, { left: n.x + 'px', top: n.y + 'px', width: n.width + 'px', height: n.height + 'px' });
  }

  private edgePath(e: CEdge): string | null {
    const a = this.data.nodes.find((n) => n.id === e.fromNode);
    const b = this.data.nodes.find((n) => n.id === e.toNode);
    if (!a || !b) return null;
    const [sa, sb] = bestSides(a, b);
    const s1 = e.fromSide ?? sa;
    const s2 = e.toSide ?? sb;
    const p1 = anchor(a, s1);
    const p2 = anchor(b, s2);
    const d = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
    const n1 = normal(s1);
    const n2 = normal(s2);
    return `M${p1.x},${p1.y} C${p1.x + n1.x * d},${p1.y + n1.y * d} ${p2.x + n2.x * d},${p2.y + n2.y * d} ${p2.x},${p2.y}`;
  }

  private renderEdges() {
    this.svg.querySelectorAll('g.canvas-edge').forEach((g) => g.remove());
    for (const e of this.data.edges) {
      const d = this.edgePath(e);
      if (!d) continue;
      const g = document.createElementNS(SVGNS, 'g');
      g.classList.add('canvas-edge');
      if (this.selected?.kind === 'edge' && this.selected.id === e.id) g.classList.add('is-selected');
      g.dataset.id = e.id;
      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('d', d);
      hit.classList.add('canvas-edge-hit');
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', d);
      path.classList.add('canvas-edge-line');
      const color = colorOf(e.color);
      if (color) path.style.stroke = color;
      if ((e.toEnd ?? 'arrow') === 'arrow') path.setAttribute('marker-end', 'url(#cv-arrow)');
      if (e.fromEnd === 'arrow') path.setAttribute('marker-start', 'url(#cv-arrow)');
      g.append(hit, path);
      if (e.label) {
        const len = path.getTotalLength?.() ?? 0;
        const mid = len ? path.getPointAtLength(len / 2) : { x: 0, y: 0 };
        const text = document.createElementNS(SVGNS, 'text');
        text.setAttribute('x', String(mid.x));
        text.setAttribute('y', String(mid.y));
        text.classList.add('canvas-edge-label');
        text.textContent = e.label;
        g.append(text);
      }
      this.svg.append(g);
    }
  }

  // ------------------------------------------------------------ edición

  private addNode(partial: Partial<CNode> & { type: CNode['type'] }) {
    const n: CNode = { id: uid(), x: 0, y: 0, width: 260, height: 120, ...partial };
    this.data.nodes.push(n);
    this.renderNode(n);
    this.select({ kind: 'node', id: n.id });
    this.changed();
    return n;
  }

  private addText(at: { x: number; y: number }) {
    const n = this.addNode({ type: 'text', text: '', ...at });
    this.startEditing(n.id);
  }

  private pickFile(at: { x: number; y: number }) {
    new SuggestModal<string>(
      'Elige una nota o archivo…',
      async (q) => (await this.app.backend.quickSwitch(q, 30)).map((x) => ({ value: x.path, title: x.title, note: x.path })),
      (it) => {
        if (it) this.addNode({ type: 'file', file: it.value, ...at, width: 320, height: IMAGE_EXT.has(extname(it.value)) ? 240 : 300 });
      },
    ).open();
  }

  private select(s: { kind: 'node' | 'edge'; id: string } | null) {
    this.selected = s;
    this.nodeEls.forEach((el, id) => el.classList.toggle('is-selected', s?.kind === 'node' && s.id === id));
    this.svg.querySelectorAll<SVGGElement>('g.canvas-edge').forEach((g) => g.classList.toggle('is-selected', s?.kind === 'edge' && s.id === g.dataset.id));
  }

  private deleteSelected() {
    const s = this.selected;
    if (!s) return;
    if (s.kind === 'node') {
      this.data.nodes = this.data.nodes.filter((n) => n.id !== s.id);
      this.data.edges = this.data.edges.filter((e) => e.fromNode !== s.id && e.toNode !== s.id);
      this.nodeEls.get(s.id)?.remove();
      this.nodeEls.delete(s.id);
    } else {
      this.data.edges = this.data.edges.filter((e) => e.id !== s.id);
    }
    this.selected = null;
    this.renderEdges();
    this.changed();
  }

  private startEditing(id: string) {
    const n = this.data.nodes.find((x) => x.id === id);
    const el = this.nodeEls.get(id);
    if (!n || !el) return;
    if (n.type === 'file' && n.file) {
      void this.app.open(this.app.resolver.resolve(n.file, '') ?? n.file, { newLeaf: true });
      return;
    }
    if (n.type !== 'text' && n.type !== 'group') return;
    this.editing = id;
    const content = el.querySelector('.canvas-node-content') as HTMLElement;
    const ta = h('textarea.canvas-node-editor', { spellcheck: 'true' }) as HTMLTextAreaElement;
    ta.value = n.type === 'text' ? n.text ?? '' : n.label ?? '';
    content.replaceChildren(ta);
    ta.focus();
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') ta.blur();
    });
    ta.addEventListener('blur', () => {
      if (n.type === 'text') n.text = ta.value;
      else n.label = ta.value;
      this.editing = null;
      void this.fillContent(n, content);
      this.changed();
    });
  }

  private bind() {
    const w = this.wrapper;
    let mode: null | { kind: 'pan'; sx: number; sy: number; tx: number; ty: number } | { kind: 'move'; ids: string[]; sx: number; sy: number; orig: { x: number; y: number }[] } | { kind: 'resize'; id: string; sx: number; sy: number; ow: number; oh: number } | { kind: 'connect'; from: string; side: Side } = null;

    w.addEventListener('pointerdown', (e) => {
      if (this.editing && (e.target as HTMLElement).closest('.canvas-node-editor')) return;
      const t = e.target as HTMLElement;
      const nodeEl = t.closest<HTMLElement>('.canvas-node');
      const edgeEl = t.closest('g.canvas-edge') as SVGGElement | null;
      w.focus({ preventScroll: true });
      if (t.classList.contains('canvas-handle') && nodeEl) {
        mode = { kind: 'connect', from: nodeEl.dataset.id!, side: t.dataset.side as Side };
        this.tempLine = document.createElementNS(SVGNS, 'path');
        this.tempLine.classList.add('canvas-edge-line', 'is-temp');
        this.svg.append(this.tempLine);
      } else if (t.classList.contains('canvas-resize') && nodeEl) {
        const n = this.data.nodes.find((x) => x.id === nodeEl.dataset.id)!;
        mode = { kind: 'resize', id: n.id, sx: e.clientX, sy: e.clientY, ow: n.width, oh: n.height };
      } else if (nodeEl) {
        if ((t.closest('a') && !t.closest('.canvas-file-title')) || this.editing === nodeEl.dataset.id) return;
        const n = this.data.nodes.find((x) => x.id === nodeEl.dataset.id)!;
        this.select({ kind: 'node', id: n.id });
        // Mover un grupo arrastra también su contenido.
        const ids = [n.id];
        if (n.type === 'group') {
          for (const o of this.data.nodes) {
            if (o.id !== n.id && o.x >= n.x && o.y >= n.y && o.x + o.width <= n.x + n.width && o.y + o.height <= n.y + n.height) ids.push(o.id);
          }
        }
        mode = { kind: 'move', ids, sx: e.clientX, sy: e.clientY, orig: ids.map((id) => { const o = this.data.nodes.find((x) => x.id === id)!; return { x: o.x, y: o.y }; }) };
      } else if (edgeEl) {
        this.select({ kind: 'edge', id: edgeEl.dataset.id! });
        return;
      } else {
        this.select(null);
        mode = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: this.t.x, ty: this.t.y };
      }
      w.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    w.addEventListener('pointermove', (e) => {
      if (!mode) return;
      if (mode.kind === 'pan') {
        this.t.x = mode.tx + e.clientX - mode.sx;
        this.t.y = mode.ty + e.clientY - mode.sy;
        this.applyTransform();
      } else if (mode.kind === 'move') {
        const dx = (e.clientX - mode.sx) / this.t.k;
        const dy = (e.clientY - mode.sy) / this.t.k;
        mode.ids.forEach((id, i) => {
          const n = this.data.nodes.find((x) => x.id === id)!;
          const m = mode as { orig: { x: number; y: number }[] };
          n.x = Math.round(m.orig[i].x + dx);
          n.y = Math.round(m.orig[i].y + dy);
          this.positionNode(this.nodeEls.get(id)!, n);
        });
        this.renderEdges();
      } else if (mode.kind === 'resize') {
        const n = this.data.nodes.find((x) => x.id === (mode as { id: string }).id)!;
        n.width = Math.max(80, Math.round(mode.ow + (e.clientX - mode.sx) / this.t.k));
        n.height = Math.max(40, Math.round(mode.oh + (e.clientY - mode.sy) / this.t.k));
        this.positionNode(this.nodeEls.get(n.id)!, n);
        this.renderEdges();
      } else if (mode.kind === 'connect' && this.tempLine) {
        const a = this.data.nodes.find((x) => x.id === (mode as { from: string }).from)!;
        const p1 = anchor(a, mode.side);
        const p2 = this.toWorld(e.clientX, e.clientY);
        this.tempLine.setAttribute('d', `M${p1.x},${p1.y} L${p2.x},${p2.y}`);
      }
    });

    w.addEventListener('pointerup', (e) => {
      if (mode?.kind === 'connect') {
        this.tempLine?.remove();
        this.tempLine = null;
        const p = this.toWorld(e.clientX, e.clientY);
        const target = this.data.nodes
          .filter((n) => n.id !== (mode as { from: string }).from && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height)
          .sort((a, b) => a.width * a.height - b.width * b.height)[0];
        if (target) {
          const from = this.data.nodes.find((n) => n.id === (mode as { from: string }).from)!;
          const toSide = bestSides(from, target)[1];
          this.data.edges.push({ id: uid(), fromNode: from.id, fromSide: mode.side, toNode: target.id, toSide });
          this.renderEdges();
          this.changed();
        }
      } else if (mode?.kind === 'move' || mode?.kind === 'resize') {
        this.changed();
      }
      mode = null;
    });

    w.addEventListener('dblclick', (e) => {
      const t = e.target as HTMLElement;
      const nodeEl = t.closest<HTMLElement>('.canvas-node');
      if (nodeEl) {
        this.startEditing(nodeEl.dataset.id!);
        return;
      }
      const edgeEl = t.closest('g.canvas-edge') as SVGGElement | null;
      if (edgeEl) {
        const edge = this.data.edges.find((x) => x.id === edgeEl.dataset.id);
        const label = prompt('Etiqueta de la conexión', edge?.label ?? '');
        if (edge && label !== null) {
          edge.label = label || undefined;
          this.renderEdges();
          this.changed();
        }
        return;
      }
      const p = this.toWorld(e.clientX, e.clientY);
      this.addText({ x: Math.round(p.x - 130), y: Math.round(p.y - 60) });
    });

    w.addEventListener('wheel', (e) => {
      if ((e.target as HTMLElement).closest('.canvas-node-content') && !e.ctrlKey && !e.metaKey) {
        const c = (e.target as HTMLElement).closest('.canvas-node-content')!;
        if (c.scrollHeight > c.clientHeight) return;
      }
      e.preventDefault();
      const r = w.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.deltaX) {
        const k = Math.min(3, Math.max(0.1, this.t.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        this.t.x = px - ((px - this.t.x) / this.t.k) * k;
        this.t.y = py - ((py - this.t.y) / this.t.k) * k;
        this.t.k = k;
      } else {
        this.t.x -= e.deltaX;
        this.t.y -= e.deltaY;
      }
      this.applyTransform();
    }, { passive: false });

    w.addEventListener('keydown', (e) => {
      if (this.editing) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === 'Enter' && this.selected?.kind === 'node') {
        e.preventDefault();
        this.startEditing(this.selected.id);
      } else if (/^[1-6]$/.test(e.key) && this.selected?.kind === 'node') {
        const n = this.data.nodes.find((x) => x.id === this.selected!.id)!;
        n.color = n.color === e.key ? undefined : e.key;
        this.nodeEls.get(n.id)!.style.setProperty('--canvas-color', colorOf(n.color));
        this.changed();
      }
    });

    // Soltar archivos desde el explorador.
    w.addEventListener('dragover', (e) => e.preventDefault());
    w.addEventListener('drop', (e) => {
      const p = e.dataTransfer?.getData('text/x-nexo-path');
      if (!p) return;
      e.preventDefault();
      const at = this.toWorld(e.clientX, e.clientY);
      this.addNode({ type: 'file', file: p, x: Math.round(at.x), y: Math.round(at.y), width: 320, height: 300 });
    });
  }
}
