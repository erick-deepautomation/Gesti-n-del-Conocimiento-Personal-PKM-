import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { Graph, GraphOptions } from '../backend/types';
import type { App } from '../core/app';
import { debounce, fold, h } from '../core/util';
import { View } from '../ui/workspace';

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: string;
  degree: number;
  r: number;
}
type SimLink = SimulationLinkDatum<SimNode> & { source: SimNode; target: SimNode };

export interface GraphForces {
  repel: number;
  linkDistance: number;
  center: number;
  nodeSize: number;
  textFade: number;
}

export const DEFAULT_FORCES: GraphForces = { repel: 120, linkDistance: 60, center: 0.05, nodeSize: 1, textFade: 1.1 };

/** Motor de grafo en canvas 2D con simulación de fuerzas (Barnes–Hut). */
export class GraphRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private neighbors = new Map<SimNode, Set<SimNode>>();
  private sim: Simulation<SimNode, SimLink>;
  private t = { x: 0, y: 0, k: 1 };
  private hover: SimNode | null = null;
  private drag: SimNode | null = null;
  private raf = 0;
  private dpr = window.devicePixelRatio || 1;
  private w = 0;
  private hgt = 0;
  private ro: ResizeObserver;
  private colors = { node: '#999', line: '#555', text: '#ddd', accent: '#8b5cf6', tag: '#4ade80', unresolved: '#777', attachment: '#eab308', bg: '#1e1e24' };
  forces: GraphForces = { ...DEFAULT_FORCES };
  activeId: string | null = null;
  private fitted = false;

  constructor(readonly container: HTMLElement, private onOpen: (id: string, newTab: boolean) => void) {
    this.canvas = h('canvas.graph-canvas') as HTMLCanvasElement;
    container.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.sim = forceSimulation<SimNode, SimLink>()
      .alphaDecay(0.03)
      .velocityDecay(0.35)
      .on('tick', () => this.requestDraw());
    this.applyForces();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.bindEvents();
  }

  readColors() {
    const cs = getComputedStyle(this.container);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    this.colors = {
      node: v('--graph-node', '#999'),
      line: v('--graph-line', '#555'),
      text: v('--graph-text', '#ddd'),
      accent: v('--accent', '#8b5cf6'),
      tag: v('--graph-tag', '#4ade80'),
      unresolved: v('--graph-unresolved', '#777'),
      attachment: v('--graph-attachment', '#eab308'),
      bg: v('--background-primary', '#1e1e24'),
    };
    this.requestDraw();
  }

  applyForces() {
    const f = this.forces;
    this.sim
      .force('charge', forceManyBody<SimNode>().strength(-f.repel).theta(0.9).distanceMax(1200))
      .force('link', forceLink<SimNode, SimLink>(this.links).id((d) => d.id).distance(f.linkDistance).strength(0.6))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(f.center))
      .force('y', forceY(0).strength(f.center))
      .force('collide', forceCollide<SimNode>((d) => d.r + 2));
    this.nodes.forEach((n) => (n.r = this.radius(n)));
    this.sim.alpha(0.5).restart();
  }

  private radius(n: { degree: number; kind: string }) {
    return (n.kind === 'tag' ? 3.5 : 4) * this.forces.nodeSize + Math.sqrt(n.degree) * 1.6 * this.forces.nodeSize;
  }

  setData(g: Graph) {
    const old = new Map(this.nodes.map((n) => [n.id, n]));
    this.nodes = g.nodes.map((n) => {
      const o = old.get(n.id);
      const r = this.radius(n);
      if (o) return Object.assign(o, { label: n.label, kind: n.kind, degree: n.degree, r });
      return { ...n, r, x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300 };
    });
    this.links = g.edges.map(([a, b]) => ({ source: this.nodes[a], target: this.nodes[b] }));
    this.neighbors.clear();
    for (const l of this.links) {
      if (!this.neighbors.has(l.source)) this.neighbors.set(l.source, new Set());
      if (!this.neighbors.has(l.target)) this.neighbors.set(l.target, new Set());
      this.neighbors.get(l.source)!.add(l.target);
      this.neighbors.get(l.target)!.add(l.source);
    }
    this.sim.nodes(this.nodes);
    (this.sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>>).links(this.links);
    this.sim.alpha(old.size ? 0.3 : 1).restart();
    if (!this.fitted) {
      this.fitted = true;
      this.t = { x: 0, y: 0, k: this.nodes.length > 300 ? 0.4 : this.nodes.length > 60 ? 0.7 : 1 };
    }
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    this.w = r.width;
    this.hgt = r.height;
    this.canvas.width = Math.max(1, r.width * this.dpr);
    this.canvas.height = Math.max(1, r.height * this.dpr);
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.readColors();
    this.requestDraw();
  }

  private requestDraw() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private toWorld(x: number, y: number) {
    return { x: (x - this.w / 2 - this.t.x) / this.t.k, y: (y - this.hgt / 2 - this.t.y) / this.t.k };
  }

  private nodeAt(x: number, y: number): SimNode | null {
    const p = this.toWorld(x, y);
    let best: SimNode | null = null;
    let bd = Infinity;
    for (const n of this.nodes) {
      const dx = n.x! - p.x;
      const dy = n.y! - p.y;
      const d = dx * dx + dy * dy;
      const rr = (n.r + 4 / this.t.k) ** 2;
      if (d < rr && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  private draw() {
    const { ctx, t, colors } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.hgt);
    ctx.translate(this.w / 2 + t.x, this.hgt / 2 + t.y);
    ctx.scale(t.k, t.k);

    const focus = this.hover ?? this.drag;
    const nb = focus ? this.neighbors.get(focus) ?? new Set<SimNode>() : null;

    // Aristas
    ctx.lineWidth = 1 / Math.max(0.6, t.k);
    ctx.strokeStyle = colors.line;
    ctx.globalAlpha = focus ? 0.15 : 0.6;
    ctx.beginPath();
    for (const l of this.links) {
      ctx.moveTo(l.source.x!, l.source.y!);
      ctx.lineTo(l.target.x!, l.target.y!);
    }
    ctx.stroke();
    if (focus) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5 / Math.max(0.6, t.k);
      ctx.beginPath();
      for (const l of this.links) {
        if (l.source === focus || l.target === focus) {
          ctx.moveTo(l.source.x!, l.source.y!);
          ctx.lineTo(l.target.x!, l.target.y!);
        }
      }
      ctx.stroke();
    }

    // Nodos
    for (const n of this.nodes) {
      const dim = focus && n !== focus && !nb!.has(n);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.fillStyle =
        n.id === this.activeId || n === focus ? colors.accent
          : n.kind === 'tag' ? colors.tag
          : n.kind === 'unresolved' ? colors.unresolved
          : n.kind === 'attachment' ? colors.attachment
          : colors.node;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Etiquetas (se desvanecen al alejar)
    const fade = Math.min(1, Math.max(0, (t.k - this.forces.textFade * 0.5) / 0.5));
    ctx.font = `${12 / Math.max(1, t.k * 0.9)}px var(--font-interface, sans-serif)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.text;
    for (const n of this.nodes) {
      const important = n === focus || (nb && nb.has(n)) || n.id === this.activeId;
      const a = important ? 1 : focus ? 0.15 * fade : fade;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillText(n.label.length > 40 ? n.label.slice(0, 38) + '…' : n.label, n.x!, n.y! + n.r + 2);
    }
    ctx.globalAlpha = 1;
  }

  private bindEvents() {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let start = { x: 0, y: 0 };
    let moved = false;
    let pan: { x: number; y: number; tx: number; ty: number } | null = null;
    let pinch: { d: number; k: number } | null = null;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.t.k };
        pan = null;
        this.drag = null;
        return;
      }
      start = p;
      moved = false;
      const n = this.nodeAt(p.x, p.y);
      if (n) {
        this.drag = n;
        n.fx = n.x;
        n.fy = n.y;
        this.sim.alphaTarget(0.2).restart();
      } else {
        pan = { x: p.x, y: p.y, tx: this.t.x, ty: this.t.y };
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        this.t.k = Math.min(8, Math.max(0.05, (pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d));
        this.requestDraw();
        return;
      }
      if (Math.hypot(p.x - start.x, p.y - start.y) > 3) moved = true;
      if (this.drag) {
        const w = this.toWorld(p.x, p.y);
        this.drag.fx = w.x;
        this.drag.fy = w.y;
        this.requestDraw();
      } else if (pan) {
        this.t.x = pan.tx + (p.x - pan.x);
        this.t.y = pan.ty + (p.y - pan.y);
        this.requestDraw();
      } else {
        const n = this.nodeAt(p.x, p.y);
        if (n !== this.hover) {
          this.hover = n;
          c.style.cursor = n ? 'pointer' : 'grab';
          c.title = n ? n.label : '';
          this.requestDraw();
        }
      }
    });

    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (this.drag) {
        const n = this.drag;
        n.fx = null;
        n.fy = null;
        this.sim.alphaTarget(0);
        this.drag = null;
        if (!moved && n.kind !== 'unresolved') this.onOpen(n.id, e.ctrlKey || e.metaKey);
        else if (!moved && n.kind === 'unresolved') this.onOpen(n.id, false);
      }
      pan = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.requestDraw();
      }
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        const k = Math.min(8, Math.max(0.05, this.t.k * Math.exp(-e.deltaY * 0.0015)));
        // Zoom centrado en el cursor.
        const wx = (p.x - this.w / 2 - this.t.x) / this.t.k;
        const wy = (p.y - this.hgt / 2 - this.t.y) / this.t.k;
        this.t.k = k;
        this.t.x = p.x - this.w / 2 - wx * k;
        this.t.y = p.y - this.hgt / 2 - wy * k;
        this.requestDraw();
      },
      { passive: false },
    );
  }

  destroy() {
    this.sim.stop();
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }
}

// ------------------------------------------------------------------ vista de grafo global

export class GraphView extends View {
  readonly type = 'graph';
  private renderer: GraphRenderer;
  private opts: GraphOptions = { tags: false, attachments: false, unresolved: false, orphans: true };
  private filter = '';
  private stats: HTMLElement;
  private offs: (() => void)[] = [];
  private reload = debounce(() => void this.load(), 400);

  constructor(app: App) {
    super(app);
    this.el.classList.add('graph-view');
    const host = h('div.graph-host');
    this.el.append(host);
    this.renderer = new GraphRenderer(host, (id, newTab) => {
      if (id.startsWith('tag:')) app.searchFor(`tag:#${id.slice(4)}`);
      else if (id.startsWith('unresolved:')) void app.openLinkText(id.slice(11), '', {});
      else void app.open(id, { newLeaf: newTab });
    });
    this.stats = h('div.graph-stats');
    this.el.append(this.controls(), this.stats);
    this.offs.push(app.events.on('files-changed', () => this.reload()), app.events.on('modified', () => this.reload()), app.events.on('settings', () => this.renderer.readColors()));
  }

  private controls() {
    const check = (label: string, key: keyof GraphOptions) => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = !!this.opts[key];
      cb.addEventListener('change', () => {
        this.opts[key] = cb.checked;
        void this.load();
      });
      return h('label.graph-control-row', cb, label);
    };
    const slider = (label: string, key: keyof GraphForces, min: number, max: number, step: number) => {
      const s = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
      s.value = String(this.renderer.forces[key]);
      s.addEventListener('input', () => {
        this.renderer.forces[key] = Number(s.value);
        this.renderer.applyForces();
      });
      return h('label.graph-control-row.slider', h('span', label), s);
    };
    const search = h('input.graph-filter', { type: 'search', placeholder: 'Filtrar archivos…' }) as HTMLInputElement;
    search.addEventListener('input', debounce(() => {
      this.filter = fold(search.value.trim());
      void this.load();
    }, 200));
    const panel = h('details.graph-controls', { open: true },
      h('summary', 'Ajustes del grafo'),
      search,
      h('div.graph-section-title', 'Filtros'),
      check('Etiquetas', 'tags'),
      check('Adjuntos', 'attachments'),
      check('Sin resolver', 'unresolved'),
      check('Huérfanas', 'orphans'),
      h('div.graph-section-title', 'Fuerzas'),
      slider('Repulsión', 'repel', 10, 600, 10),
      slider('Distancia de enlace', 'linkDistance', 10, 300, 5),
      slider('Centrado', 'center', 0, 0.3, 0.01),
      slider('Tamaño de nodo', 'nodeSize', 0.3, 3, 0.1),
      slider('Umbral de texto', 'textFade', 0.2, 4, 0.1),
    );
    return panel;
  }

  async load() {
    const t0 = performance.now();
    let g = await this.app.backend.graph(this.opts);
    if (this.filter) g = filterGraph(g, (n) => fold(n.label).includes(this.filter) || fold(n.id).includes(this.filter));
    this.renderer.activeId = this.app.recent[0] ?? null;
    this.renderer.setData(g);
    this.stats.textContent = `${g.nodes.length} nodos · ${g.edges.length} enlaces · ${Math.round(performance.now() - t0)} ms`;
  }

  title() {
    return 'Vista de grafo';
  }
  icon() {
    return 'graph';
  }
  async setState() {
    await this.load();
  }
  destroy() {
    this.renderer.destroy();
    this.offs.forEach((f) => f());
  }
}

export function filterGraph(g: Graph, keep: (n: Graph['nodes'][number]) => boolean): Graph {
  const map = new Map<number, number>();
  const nodes: Graph['nodes'] = [];
  g.nodes.forEach((n, i) => {
    if (keep(n)) {
      map.set(i, nodes.length);
      nodes.push(n);
    }
  });
  const edges: [number, number][] = [];
  for (const [a, b] of g.edges) if (map.has(a) && map.has(b)) edges.push([map.get(a)!, map.get(b)!]);
  return { nodes, edges };
}
