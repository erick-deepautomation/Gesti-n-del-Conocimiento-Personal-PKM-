import type { App } from '../core/app';
import { h, isNote } from '../core/util';
import { extractSection, renderMarkdown, splitFrontmatter } from '../render/markdown';

/** Delegación de clics en contenido renderizado + vista previa al pasar el ratón. */
export function attachLinkHandlers(app: App, root: HTMLElement, source: () => string) {
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const link = t.closest<HTMLElement>('a.internal-link');
    if (link) {
      e.preventDefault();
      const href = link.dataset.href ?? '';
      void app.openLinkText(href, source(), { newLeaf: e.ctrlKey || e.metaKey ? true : e.shiftKey ? 'split' : false });
      return;
    }
    const tag = t.closest<HTMLElement>('a.tag');
    if (tag) {
      e.preventDefault();
      app.searchFor(`tag:#${tag.dataset.tag}`);
    }
  });
  root.addEventListener('auxclick', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('a.internal-link');
    if (link && e.button === 1) {
      e.preventDefault();
      void app.openLinkText(link.dataset.href ?? '', source(), { newLeaf: true });
    }
  });
  attachHoverPreview(app, root, source, 'a.internal-link, .cm-wikilink-rendered');
}

let popover: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let hoverSeq = 0;

export function hidePopover() {
  hoverSeq++;
  clearTimeout(hideTimer);
  popover?.remove();
  popover = null;
}
document.addEventListener('mousedown', (e) => {
  if (popover && !popover.contains(e.target as Node)) hidePopover();
}, true);
document.addEventListener('keydown', () => hidePopover(), true);

export function attachHoverPreview(app: App, root: HTMLElement, source: () => string, selector: string, requireMod = false) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  root.addEventListener('mousedown', () => clearTimeout(timer), true);
  root.addEventListener('mouseover', (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (!link || (requireMod && !(e.ctrlKey || e.metaKey))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void showPreview(app, link, source()), requireMod ? 50 : 450);
    link.addEventListener('mouseleave', () => {
      clearTimeout(timer);
      scheduleHide();
    }, { once: true });
  });
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    popover?.remove();
    popover = null;
  }, 300);
}

async function showPreview(app: App, link: HTMLElement, source: string) {
  const my = ++hoverSeq;
  const href = link.dataset.href ?? link.title ?? '';
  const [target, ...rest] = href.split('#');
  const sub = rest.join('#');
  const path = target ? app.resolver.resolve(target, source) : source;
  if (!path || !isNote(path)) return;
  let text = await app.backend.read(path);
  text = sub ? extractSection(text, sub) : splitFrontmatter(text).body;
  if (my !== hoverSeq || !link.isConnected) return;
  popover?.remove();
  const body = h('div.popover-content');
  popover = h('div.popover.hover-popover', body);
  popover.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  popover.addEventListener('mouseleave', scheduleHide);
  attachLinkHandlers(app, body, () => path);
  document.body.append(popover);
  await renderMarkdown(app, body, text.slice(0, 20000), { sourcePath: path, depth: 1 });
  const r = link.getBoundingClientRect();
  const pw = 420;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
  const below = r.bottom + 8 + 320 < window.innerHeight;
  popover.style.left = left + 'px';
  popover.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - 330)) + 'px';
}
