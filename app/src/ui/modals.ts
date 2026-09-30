import { fold, h } from '../core/util';

// ------------------------------------------------------------------ avisos

export function notice(msg: string, ms = 3500) {
  let host = document.querySelector('.notice-container');
  if (!host) {
    host = h('div.notice-container');
    document.body.append(host);
  }
  const n = h('div.notice', msg);
  n.addEventListener('click', () => n.remove());
  host.append(n);
  setTimeout(() => n.remove(), ms);
}

// ------------------------------------------------------------------ modal base

export class Modal {
  bg: HTMLElement;
  el: HTMLElement;
  private prevFocus: Element | null = document.activeElement;
  onClose?: () => void;

  constructor(cls = '') {
    this.el = h('div.modal' + (cls ? '.' + cls : ''), { role: 'dialog', 'aria-modal': 'true' });
    this.bg = h('div.modal-bg', { onmousedown: (e: MouseEvent) => e.target === this.bg && this.close() }, this.el);
    this.bg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  open() {
    document.body.append(this.bg);
    return this;
  }

  close() {
    this.bg.remove();
    this.onClose?.();
    (this.prevFocus as HTMLElement | null)?.focus?.();
  }
}

// ------------------------------------------------------------------ selector genérico (switcher, paleta…)

export interface SuggestItem<T> {
  value: T;
  title: string;
  html?: string;
  note?: string;
  aux?: string;
}

export class SuggestModal<T> extends Modal {
  input: HTMLInputElement;
  list: HTMLElement;
  items: SuggestItem<T>[] = [];
  selected = 0;
  private seq = 0;
  instructions: [string, string][] = [
    ['↑↓', 'navegar'],
    ['↵', 'abrir'],
    ['esc', 'cerrar'],
  ];

  constructor(
    placeholder: string,
    private source: (q: string) => Promise<SuggestItem<T>[]> | SuggestItem<T>[],
    private onChoose: (item: SuggestItem<T> | null, query: string, e: KeyboardEvent | MouseEvent) => void,
  ) {
    super('prompt');
    this.input = h('input.prompt-input', { type: 'text', placeholder, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    this.list = h('div.prompt-results', { role: 'listbox' });
    this.el.append(this.input, this.list);
    this.input.addEventListener('input', () => void this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  open() {
    super.open();
    const footer = h('div.prompt-instructions', this.instructions.map(([k, d]) => h('span', h('kbd', k), ' ' + d)));
    this.el.append(footer);
    this.input.focus();
    void this.refresh();
    return this;
  }

  async refresh() {
    const my = ++this.seq;
    const items = await this.source(this.input.value);
    if (my !== this.seq) return;
    this.items = items;
    this.selected = 0;
    this.render();
  }

  private render() {
    this.list.replaceChildren(
      ...this.items.map((it, i) => {
        const row = h(
          'div.suggestion-item' + (i === this.selected ? '.is-selected' : ''),
          {
            role: 'option',
            onmousemove: () => {
              if (this.selected !== i) {
                this.selected = i;
                this.updateSel();
              }
            },
            onclick: (e: MouseEvent) => this.choose(e),
          },
          h('div.suggestion-title', it.html ? { html: it.html } : it.title),
          it.note ? h('div.suggestion-note', it.note) : null,
          it.aux ? h('div.suggestion-aux', it.aux) : null,
        );
        return row;
      }),
    );
    if (!this.items.length) this.list.append(h('div.suggestion-empty', this.emptyText(this.input.value)));
  }

  emptyText(_q: string) {
    return 'Sin resultados';
  }

  private updateSel() {
    [...this.list.children].forEach((c, i) => c.classList.toggle('is-selected', i === this.selected));
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      this.selected = Math.min(this.items.length - 1, this.selected + 1);
      this.updateSel();
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      this.selected = Math.max(0, this.selected - 1);
      this.updateSel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.choose(e);
    }
  }

  private choose(e: KeyboardEvent | MouseEvent) {
    const it = this.items[this.selected] ?? null;
    const q = this.input.value;
    this.close();
    this.onChoose(it, q, e);
  }
}

/** Coincidencia difusa ligera para listas pequeñas (comandos, plantillas). */
export function fuzzyFilter<T>(items: T[], q: string, key: (t: T) => string): { item: T; html: string }[] {
  const qf = fold(q.trim()).replace(/\s+/g, '');
  if (!qf) return items.map((item) => ({ item, html: escape(key(item)) }));
  const out: { item: T; html: string; score: number }[] = [];
  for (const item of items) {
    const text = key(item);
    const t = fold(text);
    let qi = 0;
    let score = 0;
    let last = -2;
    const hits: number[] = [];
    for (let i = 0; i < t.length && qi < qf.length; i++) {
      if (t[i] === qf[qi]) {
        score += 1 + (last === i - 1 ? 4 : 0) + (i === 0 || /[\s/:_-]/.test(t[i - 1]) ? 5 : 0);
        hits.push(i);
        last = i;
        qi++;
      }
    }
    if (qi < qf.length) continue;
    let html = '';
    const set = new Set(hits);
    for (let i = 0; i < text.length; i++) html += set.has(i) ? `<span class="suggestion-highlight">${escape(text[i])}</span>` : escape(text[i]);
    out.push({ item, html, score: score - t.length * 0.05 });
  }
  return out.sort((a, b) => b.score - a.score);
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ------------------------------------------------------------------ prompt / confirm

export function promptText(title: string, value = '', placeholder = '', okLabel = 'Aceptar'): Promise<string | null> {
  return new Promise((resolve) => {
    const m = new Modal('dialog');
    const input = h('input.dialog-input', { type: 'text', value, placeholder, spellcheck: 'false' }) as HTMLInputElement;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose = () => finish(null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      }
    });
    m.el.append(
      h('div.dialog-title', title),
      input,
      h('div.dialog-buttons', h('button.mod-cta', { onclick: () => finish(input.value) }, okLabel), h('button', { onclick: () => finish(null) }, 'Cancelar')),
    );
    m.open();
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'Aceptar', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const m = new Modal('dialog');
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose = () => finish(false);
    const ok = h('button' + (danger ? '.mod-warning' : '.mod-cta'), { onclick: () => finish(true) }, okLabel);
    m.el.append(h('div.dialog-title', title), h('p.dialog-message', message), h('div.dialog-buttons', ok, h('button', { onclick: () => finish(false) }, 'Cancelar')));
    m.open();
    ok.focus();
  });
}

// ------------------------------------------------------------------ menú contextual

export interface MenuItem {
  title: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  separator?: boolean;
}

let openMenu: HTMLElement | null = null;

export function showMenu(items: MenuItem[], x: number, y: number) {
  openMenu?.remove();
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it.separator) {
      menu.append(h('div.menu-separator'));
      continue;
    }
    menu.append(
      h(
        'div.menu-item' + (it.danger ? '.is-danger' : '') + (it.disabled ? '.is-disabled' : ''),
        {
          role: 'menuitem',
          onclick: () => {
            if (it.disabled) return;
            close();
            it.onClick?.();
          },
        },
        it.title,
      ),
    );
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  openMenu = menu;
  const close = () => {
    menu.remove();
    if (openMenu === menu) openMenu = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
  });
}
