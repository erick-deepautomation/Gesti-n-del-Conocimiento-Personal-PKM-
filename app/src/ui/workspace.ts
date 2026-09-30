import type { App } from '../core/app';
import { h, icon, iconButton } from '../core/util';
import { showMenu } from './modals';

export interface ViewState {
  type: string;
  state: Record<string, any>;
}

export abstract class View {
  abstract readonly type: string;
  readonly el: HTMLElement = h('div.view-content');
  leaf!: Leaf;
  constructor(readonly app: App) {}
  abstract title(): string;
  icon() {
    return 'file';
  }
  path(): string | null {
    return null;
  }
  getState(): Record<string, any> {
    return {};
  }
  async setState(_state: Record<string, any>): Promise<void> {}
  onShow() {}
  onHide() {}
  async beforeLeave(): Promise<void> {}
  destroy() {}
  focus() {}
  onRename(_old: string, _new: string) {}
  onDelete(_paths: string[]) {}
  onExternalChange(_paths: string[]) {}
  onFilesChanged() {}
  onSettingsChanged() {}
  protected updateTitle() {
    this.leaf?.refreshTab();
  }
}

export type ViewFactory = (app: App) => View;

export class Leaf {
  view!: View;
  tabEl: HTMLElement;
  private history: ViewState[] = [];
  private hIndex = -1;
  pinned = false;

  constructor(readonly app: App, public pane: Pane) {
    this.tabEl = h('div.workspace-tab', {
      draggable: 'true',
      onclick: () => this.pane.setActive(this),
      onauxclick: (e: MouseEvent) => e.button === 1 && this.pane.workspace.closeLeaf(this),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        showMenu(
          [
            { title: 'Cerrar', onClick: () => this.pane.workspace.closeLeaf(this) },
            { title: 'Cerrar las demás', onClick: () => this.pane.leaves.filter((l) => l !== this).forEach((l) => this.pane.workspace.closeLeaf(l)) },
            { title: this.pinned ? 'Desfijar' : 'Fijar', onClick: () => { this.pinned = !this.pinned; this.refreshTab(); } },
            { separator: true, title: '' },
            { title: 'Dividir a la derecha', onClick: () => void this.pane.workspace.openState(this.getViewState(), { newLeaf: 'split' }) },
          ],
          e.clientX,
          e.clientY,
        );
      },
    });
  }

  getViewState(): ViewState {
    return { type: this.view.type, state: this.view.getState() };
  }

  async setViewState(vs: ViewState, push = true) {
    if (this.view && this.view.type === vs.type) {
      await this.view.beforeLeave();
      await this.view.setState(vs.state);
    } else {
      if (this.view) {
        await this.view.beforeLeave();
        this.view.destroy();
        this.view.el.remove();
      }
      const factory = this.pane.workspace.factories[vs.type] ?? this.pane.workspace.factories.empty;
      this.view = factory(this.app);
      this.view.leaf = this;
      if (this.pane.active === this) this.pane.contentEl.append(this.view.el);
      await this.view.setState(vs.state);
    }
    if (push) {
      this.history = this.history.slice(0, this.hIndex + 1);
      this.history.push({ type: vs.type, state: { ...this.view.getState() } });
      if (this.history.length > 100) this.history.shift();
      this.hIndex = this.history.length - 1;
    }
    this.refreshTab();
    this.pane.workspace.emitActive();
  }

  canBack() {
    return this.hIndex > 0;
  }
  canForward() {
    return this.hIndex < this.history.length - 1;
  }
  async back() {
    if (!this.canBack()) return;
    this.history[this.hIndex] = this.getViewState();
    this.hIndex--;
    await this.setViewState(this.history[this.hIndex], false);
  }
  async forward() {
    if (!this.canForward()) return;
    this.history[this.hIndex] = this.getViewState();
    this.hIndex++;
    await this.setViewState(this.history[this.hIndex], false);
  }

  /** Actualiza rutas en el historial tras renombrar. */
  renamePath(oldP: string, newP: string) {
    for (const e of this.history) {
      if (e.state.path === oldP) e.state.path = newP;
      else if (typeof e.state.path === 'string' && e.state.path.startsWith(oldP + '/')) e.state.path = newP + e.state.path.slice(oldP.length);
    }
  }

  refreshTab() {
    const title = this.view?.title() ?? '';
    this.tabEl.replaceChildren(
      icon(this.view?.icon() ?? 'file', 14),
      h('span.workspace-tab-title', title),
      this.pinned ? h('span.workspace-tab-pin', '📌') : '',
      iconButton('x', 'Cerrar', (e) => {
        e.stopPropagation();
        this.pane.workspace.closeLeaf(this);
      }, 'workspace-tab-close'),
    );
    this.tabEl.title = this.view?.path() ?? title;
    this.tabEl.classList.toggle('is-active', this.pane.active === this);
    if (this.pane.active === this) this.pane.workspace.updateHeader(this);
    this.app.saveWorkspaceSoon();
  }
}

export class Pane {
  el: HTMLElement;
  tabsEl: HTMLElement;
  contentEl: HTMLElement;
  viewHeader: HTMLElement;
  leaves: Leaf[] = [];
  active: Leaf | null = null;

  constructor(readonly app: App, readonly workspace: Workspace) {
    this.tabsEl = h('div.workspace-tabs');
    const newTab = iconButton('plus', 'Nueva pestaña', () => void this.workspace.openState({ type: 'empty', state: {} }, { newLeaf: true, pane: this }), 'workspace-tab-new');
    this.contentEl = h('div.workspace-pane-content');
    this.viewHeader = h('div.view-header');
    this.el = h('div.workspace-pane', { onmousedown: () => this.workspace.setActivePane(this) }, h('div.workspace-tab-header', this.tabsEl, newTab), this.viewHeader, this.contentEl);
  }

  addLeaf(index = this.leaves.length): Leaf {
    const leaf = new Leaf(this.app, this);
    this.leaves.splice(index, 0, leaf);
    this.tabsEl.insertBefore(leaf.tabEl, this.tabsEl.children[index] ?? null);
    return leaf;
  }

  setActive(leaf: Leaf) {
    if (this.active === leaf) {
      this.workspace.setActivePane(this);
      return;
    }
    if (this.active) {
      this.active.view.onHide();
      this.active.view.el.remove();
      this.active.tabEl.classList.remove('is-active');
    }
    this.active = leaf;
    this.contentEl.append(leaf.view.el);
    leaf.tabEl.classList.add('is-active');
    leaf.view.onShow();
    this.workspace.setActivePane(this);
    this.workspace.emitActive();
    leaf.refreshTab();
  }
}

export interface OpenOptions {
  newLeaf?: boolean | 'split';
  pane?: Pane;
  focus?: boolean;
}

export class Workspace {
  el: HTMLElement;
  panes: Pane[] = [];
  activePane!: Pane;
  factories: Record<string, ViewFactory> = {};
  onActiveChange: (leaf: Leaf | null) => void = () => {};
  onHeader: (leaf: Leaf) => void = () => {};

  constructor(readonly app: App) {
    this.el = h('div.workspace-split');
  }

  init() {
    const p = this.addPane();
    this.activePane = p;
  }

  addPane(): Pane {
    const p = new Pane(this.app, this);
    this.panes.push(p);
    if (this.panes.length > 1) this.el.append(h('div.workspace-divider'));
    this.el.append(p.el);
    this.layoutDividers();
    return p;
  }

  private layoutDividers() {
    this.el.querySelectorAll('.workspace-divider').forEach((d) => d.remove());
    this.panes.forEach((p, i) => {
      if (i > 0) {
        const div = h('div.workspace-divider');
        this.el.insertBefore(div, p.el);
        div.addEventListener('pointerdown', (e) => {
          const left = this.panes[i - 1].el;
          const right = p.el;
          const startX = e.clientX;
          const lw = left.getBoundingClientRect().width;
          const rw = right.getBoundingClientRect().width;
          div.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => {
            const dx = ev.clientX - startX;
            left.style.flex = `0 0 ${Math.max(200, lw + dx)}px`;
            right.style.flex = `1 1 ${Math.max(200, rw - dx)}px`;
          };
          const up = () => {
            div.removeEventListener('pointermove', move);
            div.removeEventListener('pointerup', up);
          };
          div.addEventListener('pointermove', move);
          div.addEventListener('pointerup', up);
        });
      }
    });
  }

  removePane(p: Pane) {
    if (this.panes.length === 1) return;
    this.panes = this.panes.filter((x) => x !== p);
    p.el.remove();
    this.panes.forEach((x) => (x.el.style.flex = ''));
    this.layoutDividers();
    if (this.activePane === p) this.setActivePane(this.panes[0]);
  }

  setActivePane(p: Pane) {
    if (this.activePane === p) return;
    this.activePane?.el.classList.remove('is-active');
    this.activePane = p;
    p.el.classList.add('is-active');
    this.emitActive();
    if (p.active) p.active.refreshTab();
  }

  activeLeaf(): Leaf | null {
    return this.activePane?.active ?? null;
  }

  leaves(): Leaf[] {
    return this.panes.flatMap((p) => p.leaves);
  }

  private lastEmitted: Leaf | null | undefined;
  private lastPath: string | null | undefined;
  emitActive() {
    const l = this.activeLeaf();
    const path = l?.view?.path() ?? null;
    if (l === this.lastEmitted && path === this.lastPath) return;
    this.lastEmitted = l;
    this.lastPath = path;
    this.onActiveChange(l);
  }

  updateHeader(leaf: Leaf) {
    this.onHeader(leaf);
  }

  async openState(vs: ViewState, opts: OpenOptions = {}): Promise<Leaf> {
    let pane = opts.pane ?? this.activePane;
    let leaf: Leaf;
    if (opts.newLeaf === 'split') {
      pane = this.panes[this.panes.indexOf(pane) + 1] ?? this.addPane();
      leaf = pane.addLeaf();
    } else if (opts.newLeaf || !pane.active || pane.active.pinned) {
      // Reutiliza una pestaña vacía si existe.
      leaf = pane.active && pane.active.view?.type === 'empty' && !opts.newLeaf ? pane.active : pane.addLeaf(pane.active ? pane.leaves.indexOf(pane.active) + 1 : pane.leaves.length);
    } else {
      leaf = pane.active;
    }
    await leaf.setViewState(vs);
    pane.setActive(leaf);
    if (opts.focus !== false) leaf.view.focus();
    return leaf;
  }

  closeLeaf(leaf: Leaf) {
    const pane = leaf.pane;
    void leaf.view.beforeLeave().then(() => {
      const i = pane.leaves.indexOf(leaf);
      pane.leaves.splice(i, 1);
      leaf.tabEl.remove();
      leaf.view.destroy();
      leaf.view.el.remove();
      if (pane.active === leaf) {
        pane.active = null;
        const next = pane.leaves[Math.min(i, pane.leaves.length - 1)];
        if (next) pane.setActive(next);
        else if (this.panes.length > 1) this.removePane(pane);
        else void this.openState({ type: 'empty', state: {} }, { pane });
      }
      this.emitActive();
      this.app.saveWorkspaceSoon();
    });
  }

  serialize() {
    return {
      panes: this.panes.map((p) => ({
        leaves: p.leaves.map((l) => ({ ...l.getViewState(), pinned: l.pinned })),
        active: p.active ? p.leaves.indexOf(p.active) : 0,
      })),
      activePane: this.panes.indexOf(this.activePane),
    };
  }

  async restore(data: any) {
    try {
      const panes = (data?.panes ?? []) as { leaves: (ViewState & { pinned?: boolean })[]; active: number }[];
      if (!panes.length) throw new Error('vacío');
      for (let pi = 0; pi < panes.length; pi++) {
        const pd = panes[pi];
        const pane = pi === 0 ? this.panes[0] : this.addPane();
        for (const lv of pd.leaves) {
          const leaf = pane.addLeaf();
          leaf.pinned = !!lv.pinned;
          await leaf.setViewState(lv);
        }
        const act = pane.leaves[pd.active] ?? pane.leaves[0];
        if (act) pane.setActive(act);
      }
      this.setActivePane(this.panes[data.activePane] ?? this.panes[0]);
    } catch {
      if (!this.panes[0].leaves.length) await this.openState({ type: 'empty', state: {} });
    }
    if (!this.panes[0].leaves.length) await this.openState({ type: 'empty', state: {} }, { pane: this.panes[0] });
  }
}
