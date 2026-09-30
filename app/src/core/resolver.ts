import type { FileInfo } from '../backend/types';

/**
 * Resolución síncrona de enlaces en el cliente (misma lógica que pkm-core)
 * para el renderizado y la vista previa en vivo, sin ida y vuelta al host.
 */
export class Resolver {
  private byPath = new Map<string, string>();
  private byName = new Map<string, string[]>();

  setFiles(files: FileInfo[]) {
    this.byPath.clear();
    this.byName.clear();
    for (const f of files) this.add(f.path);
  }

  add(path: string) {
    const l = path.toLowerCase();
    if (this.byPath.has(l)) return;
    this.byPath.set(l, path);
    const name = l.slice(l.lastIndexOf('/') + 1);
    const arr = this.byName.get(name);
    if (arr) arr.push(l);
    else this.byName.set(name, [l]);
  }

  remove(path: string) {
    const l = path.toLowerCase();
    this.byPath.delete(l);
    const name = l.slice(l.lastIndexOf('/') + 1);
    const arr = this.byName.get(name);
    if (arr) {
      const i = arr.indexOf(l);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  exists(path: string) {
    return this.byPath.has(path.toLowerCase());
  }

  resolve(target: string, from: string): string | null {
    let t = target.trim();
    if (!t) return this.byPath.get(from.toLowerCase()) ?? null;
    try {
      if (t.includes('%')) t = decodeURIComponent(t);
    } catch {
      /* se usa tal cual */
    }
    if (t.startsWith('/')) t = t.slice(1);
    const cands = t.toLowerCase().endsWith('.md') ? [t] : [t, t + '.md'];
    const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).toLowerCase() : '';
    for (const c of cands) {
      const lc = c.toLowerCase();
      const norm = normalize(lc);
      if (norm !== null && this.byPath.has(norm)) return this.byPath.get(norm)!;
      if (fromDir) {
        const rel = normalize(`${fromDir}/${lc}`);
        if (rel !== null && this.byPath.has(rel)) return this.byPath.get(rel)!;
      }
      if (norm === null) continue;
      const list = this.byName.get(norm.slice(norm.lastIndexOf('/') + 1));
      if (list?.length) {
        const suffix = '/' + norm;
        const best = list
          .filter((p) => p === norm || p.endsWith(suffix))
          .sort((a, b) => {
            const da = (a.includes('/') ? a.slice(0, a.lastIndexOf('/')) : '') === fromDir ? 0 : 1;
            const db = (b.includes('/') ? b.slice(0, b.lastIndexOf('/')) : '') === fromDir ? 0 : 1;
            return da - db || a.length - b.length || a.localeCompare(b);
          })[0];
        if (best) return this.byPath.get(best)!;
      }
    }
    return null;
  }
}

function normalize(p: string): string | null {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join('/');
}
