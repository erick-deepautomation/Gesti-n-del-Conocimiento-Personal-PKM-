//! Índice en memoria de la bóveda: archivos, notas, enlaces resueltos,
//! retroenlaces, etiquetas, búsqueda de texto completo (BM25) y grafo.
//!
//! Diseño orientado a rendimiento:
//! * La resolución de enlaces se cachea por nota y sólo se recalcula por
//!   completo cuando cambia el *conjunto* de archivos (crear/borrar/renombrar);
//!   editar una nota sólo re-resuelve sus propios enlaces.
//! * Índice invertido en `BTreeMap` → búsqueda por prefijo en O(log n).
//! * Con la feature `parallel`, el análisis inicial y la re-resolución usan
//!   todos los núcleos (rayon).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::parser::{self, percent_encode_path, Heading, LinkKind, LinkRef, ParsedNote, Task};
use crate::text::{contains_word, fold, fuzzy_score, tokenize};

pub type DocId = u32;

// ---------------------------------------------------------------- utilidades

#[inline]
fn lower(p: &str) -> String {
    p.to_lowercase()
}

pub fn is_note_path(p: &str) -> bool {
    p.len() > 3 && p[p.len() - 3..].eq_ignore_ascii_case(".md")
}

pub fn file_name(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

pub fn parent(p: &str) -> &str {
    p.rfind('/').map_or("", |i| &p[..i])
}

/// Nombre visible: sin `.md` para notas.
pub fn title_of(p: &str) -> &str {
    let n = file_name(p);
    if is_note_path(n) {
        &n[..n.len() - 3]
    } else {
        n
    }
}

fn strip_md(p: &str) -> &str {
    if is_note_path(p) {
        &p[..p.len() - 3]
    } else {
        p
    }
}

/// Normaliza `a/./b/../c` → `a/c`. `None` si escapa de la raíz.
pub fn normalize(p: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

// ---------------------------------------------------------------- tipos públicos

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub is_note: bool,
    pub mtime: f64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub target: String,
    pub subpath: Option<String>,
    pub display: Option<String>,
    pub embed: bool,
    pub line: u32,
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,
    pub title: String,
    pub frontmatter: Option<serde_json::Value>,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub headings: Vec<Heading>,
    pub block_ids: Vec<String>,
    pub tasks: Vec<Task>,
    pub word_count: u32,
    pub char_count: u32,
    pub links: Vec<ResolvedLink>,
    pub backlink_count: u32,
    pub mtime: f64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub source: String,
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unresolved {
    pub target: String,
    pub sources: Vec<String>,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub matches: Vec<Mention>,
    /// Términos plegados que el cliente puede resaltar.
    pub terms: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchHit {
    pub path: String,
    pub title: String,
    pub alias: Option<String>,
    pub is_note: bool,
    pub score: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTask {
    pub path: String,
    pub line: u32,
    pub done: bool,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphOptions {
    pub attachments: bool,
    pub unresolved: bool,
    pub tags: bool,
    pub orphans: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    /// "note" | "attachment" | "unresolved" | "tag"
    pub kind: &'static str,
    pub degree: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub files: u32,
    pub notes: u32,
    pub terms: u32,
    pub links: u32,
    pub words: u64,
}

// ---------------------------------------------------------------- internos

struct Doc {
    path: String,
    content: String,
    parsed: ParsedNote,
    title_folded: String,
    terms: Vec<(Box<str>, u32)>,
    len: u32,
    resolved: Vec<Option<String>>,
}

struct FileEntry {
    path: String,
    mtime: f64,
    size: u64,
    doc: Option<DocId>,
}

/// Nota analizada lista para insertar (se construye en paralelo).
pub struct Prepared {
    path: String,
    content: String,
    parsed: ParsedNote,
    title_folded: String,
    terms: Vec<(Box<str>, u32)>,
    len: u32,
    mtime: f64,
    size: u64,
}

pub fn prepare(path: String, content: String, mtime: f64, size: u64) -> Prepared {
    let parsed = parser::parse(&content);
    let title_folded = fold(title_of(&path));
    let (terms, len) = index_terms(&content, &title_folded);
    Prepared { path, content, parsed, title_folded, terms, len, mtime, size }
}

fn index_terms(content: &str, title_folded: &str) -> (Vec<(Box<str>, u32)>, u32) {
    let folded = fold(content);
    let mut tf: HashMap<&str, u32> = HashMap::new();
    let mut len = 0u32;
    for t in tokenize(&folded) {
        if t.len() > 64 {
            continue;
        }
        *tf.entry(t).or_insert(0) += 1;
        len += 1;
    }
    for t in tokenize(title_folded) {
        *tf.entry(t).or_insert(0) += 3;
    }
    (tf.into_iter().map(|(k, v)| (Box::from(k), v)).collect(), len)
}

// ---------------------------------------------------------------- índice

#[derive(Default)]
pub struct Index {
    docs: Vec<Option<Doc>>,
    free: Vec<DocId>,
    files: HashMap<String, FileEntry>,
    by_name: HashMap<String, Vec<String>>,
    postings: BTreeMap<Box<str>, Vec<(DocId, u32)>>,
    total_len: u64,
    n_docs: u32,
    backrefs: HashMap<String, Vec<DocId>>,
    links_dirty: bool,
}

impl Index {
    pub fn new() -> Self {
        Self::default()
    }

    // ------------------------------------------------------------ mutación

    pub fn upsert_note(&mut self, path: &str, content: String, mtime: f64, size: u64) {
        let p = prepare(path.to_string(), content, mtime, size);
        self.insert_prepared(p);
    }

    /// Carga masiva (análisis en paralelo con la feature `parallel`).
    pub fn bulk_insert(&mut self, items: Vec<(String, String, f64, u64)>) {
        #[cfg(feature = "parallel")]
        let prepared: Vec<Prepared> = {
            use rayon::prelude::*;
            items.into_par_iter().map(|(p, c, m, s)| prepare(p, c, m, s)).collect()
        };
        #[cfg(not(feature = "parallel"))]
        let prepared: Vec<Prepared> = items.into_iter().map(|(p, c, m, s)| prepare(p, c, m, s)).collect();
        self.links_dirty = true;
        for p in prepared {
            self.insert_prepared(p);
        }
    }

    pub fn insert_prepared(&mut self, p: Prepared) {
        let key = lower(&p.path);
        let existing = self.files.get(&key).and_then(|f| f.doc);
        if let Some(id) = existing {
            self.remove_postings(id);
            if !self.links_dirty {
                self.remove_backrefs(id);
            }
            let fe = self.files.get_mut(&key).unwrap();
            fe.mtime = p.mtime;
            fe.size = p.size;
            fe.path = p.path.clone();
            self.docs[id as usize] = Some(Doc {
                path: p.path,
                content: p.content,
                parsed: p.parsed,
                title_folded: p.title_folded,
                terms: p.terms,
                len: p.len,
                resolved: vec![],
            });
            self.add_postings(id);
            if !self.links_dirty {
                let r = self.compute_resolved(self.docs[id as usize].as_ref().unwrap());
                self.docs[id as usize].as_mut().unwrap().resolved = r;
                self.add_backrefs(id);
            }
            return;
        }
        if self.files.contains_key(&key) {
            // Existía como adjunto (no debería ocurrir con .md) → reemplazar.
            self.remove(&p.path.clone());
        }
        let id = match self.free.pop() {
            Some(id) => id,
            None => {
                self.docs.push(None);
                (self.docs.len() - 1) as DocId
            }
        };
        self.register_file(&p.path, p.mtime, p.size, Some(id));
        self.docs[id as usize] = Some(Doc {
            path: p.path,
            content: p.content,
            parsed: p.parsed,
            title_folded: p.title_folded,
            terms: p.terms,
            len: p.len,
            resolved: vec![],
        });
        self.n_docs += 1;
        self.add_postings(id);
        self.links_dirty = true;
    }

    /// Registra un archivo que no es nota (imagen, PDF, .canvas…).
    pub fn add_file(&mut self, path: &str, mtime: f64, size: u64) {
        let key = lower(path);
        if let Some(fe) = self.files.get_mut(&key) {
            fe.mtime = mtime;
            fe.size = size;
            return;
        }
        self.register_file(path, mtime, size, None);
        self.links_dirty = true;
    }

    fn register_file(&mut self, path: &str, mtime: f64, size: u64, doc: Option<DocId>) {
        let key = lower(path);
        self.by_name.entry(file_name(&key).to_string()).or_default().push(key.clone());
        self.files.insert(key, FileEntry { path: path.to_string(), mtime, size, doc });
    }

    fn unregister_file(&mut self, key: &str) -> Option<FileEntry> {
        let fe = self.files.remove(key)?;
        let name = file_name(key);
        if let Some(v) = self.by_name.get_mut(name) {
            v.retain(|p| p != key);
            if v.is_empty() {
                self.by_name.remove(name);
            }
        }
        Some(fe)
    }

    pub fn remove(&mut self, path: &str) -> bool {
        let key = lower(path);
        let Some(fe) = self.unregister_file(&key) else { return false };
        if let Some(id) = fe.doc {
            self.remove_postings(id);
            self.docs[id as usize] = None;
            self.free.push(id);
            self.n_docs -= 1;
        }
        self.links_dirty = true;
        true
    }

    /// Elimina todo lo que cuelga de una carpeta. Devuelve las rutas eliminadas.
    pub fn remove_folder(&mut self, folder: &str) -> Vec<String> {
        let prefix = format!("{}/", lower(folder.trim_end_matches('/')));
        let paths: Vec<String> = self.files.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, f)| f.path.clone()).collect();
        for p in &paths {
            self.remove(p);
        }
        paths
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    fn add_postings(&mut self, id: DocId) {
        let doc = self.docs[id as usize].as_ref().unwrap();
        self.total_len += doc.len as u64;
        for (t, tf) in &doc.terms {
            self.postings.entry(t.clone()).or_default().push((id, *tf));
        }
    }

    fn remove_postings(&mut self, id: DocId) {
        let Some(doc) = self.docs[id as usize].as_ref() else { return };
        self.total_len -= doc.len as u64;
        for (t, _) in &doc.terms {
            if let Some(v) = self.postings.get_mut(t) {
                v.retain(|(d, _)| *d != id);
                if v.is_empty() {
                    self.postings.remove(t);
                }
            }
        }
    }

    fn remove_backrefs(&mut self, id: DocId) {
        let Some(doc) = self.docs[id as usize].as_ref() else { return };
        for r in doc.resolved.iter().flatten() {
            if let Some(v) = self.backrefs.get_mut(&lower(r)) {
                v.retain(|d| *d != id);
            }
        }
    }

    fn add_backrefs(&mut self, id: DocId) {
        let doc = self.docs[id as usize].as_ref().unwrap();
        let keys: HashSet<String> = doc.resolved.iter().flatten().map(|r| lower(r)).collect();
        for k in keys {
            let v = self.backrefs.entry(k).or_default();
            if !v.contains(&id) {
                v.push(id);
            }
        }
    }

    fn compute_resolved(&self, doc: &Doc) -> Vec<Option<String>> {
        doc.parsed.links.iter().map(|l| self.resolve(&l.target, &doc.path)).collect()
    }

    fn ensure_links(&mut self) {
        if !self.links_dirty {
            return;
        }
        let ids: Vec<DocId> = (0..self.docs.len() as DocId).filter(|&i| self.docs[i as usize].is_some()).collect();
        #[cfg(feature = "parallel")]
        let results: Vec<(DocId, Vec<Option<String>>)> = {
            use rayon::prelude::*;
            let this = &*self;
            ids.par_iter().map(|&i| (i, this.compute_resolved(this.docs[i as usize].as_ref().unwrap()))).collect()
        };
        #[cfg(not(feature = "parallel"))]
        let results: Vec<(DocId, Vec<Option<String>>)> =
            ids.iter().map(|&i| (i, self.compute_resolved(self.docs[i as usize].as_ref().unwrap()))).collect();
        self.backrefs.clear();
        for (id, r) in results {
            self.docs[id as usize].as_mut().unwrap().resolved = r;
            self.add_backrefs(id);
        }
        self.links_dirty = false;
    }

    // ------------------------------------------------------------ consultas básicas

    pub fn exists(&self, path: &str) -> bool {
        self.files.contains_key(&lower(path))
    }

    /// Ruta con la grafía real guardada en el índice.
    pub fn canonical(&self, path: &str) -> Option<String> {
        self.files.get(&lower(path)).map(|f| f.path.clone())
    }

    pub fn content(&self, path: &str) -> Option<&str> {
        let id = self.files.get(&lower(path))?.doc?;
        self.docs[id as usize].as_ref().map(|d| d.content.as_str())
    }

    pub fn files(&self) -> Vec<FileInfo> {
        let mut v: Vec<FileInfo> = self
            .files
            .values()
            .map(|f| FileInfo { path: f.path.clone(), is_note: f.doc.is_some(), mtime: f.mtime, size: f.size })
            .collect();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        v
    }

    pub fn stats(&self) -> Stats {
        let mut links = 0u32;
        let mut words = 0u64;
        for d in self.docs.iter().flatten() {
            links += d.parsed.links.len() as u32;
            words += d.parsed.word_count as u64;
        }
        Stats { files: self.files.len() as u32, notes: self.n_docs, terms: self.postings.len() as u32, links, words }
    }

    fn doc_by_path(&self, path: &str) -> Option<(DocId, &Doc)> {
        let id = self.files.get(&lower(path))?.doc?;
        self.docs[id as usize].as_ref().map(|d| (id, d))
    }

    /// Resolución de enlaces al estilo Obsidian: ruta exacta → relativa a la
    /// nota → por nombre de archivo (prefiriendo la misma carpeta y la ruta más corta).
    pub fn resolve(&self, target: &str, from: &str) -> Option<String> {
        let t = target.trim();
        if t.is_empty() {
            return self.files.get(&lower(from)).map(|f| f.path.clone());
        }
        let t = t.strip_prefix('/').unwrap_or(t);
        let with_md;
        let cands: &[&str] = if is_note_path(t) {
            &[t]
        } else {
            with_md = format!("{t}.md");
            &[t, with_md.as_str()]
        };
        let from_dir = lower(parent(from));
        for c in cands {
            let lc = lower(c);
            let norm = normalize(&lc);
            if let Some(f) = norm.as_ref().and_then(|n| self.files.get(n)) {
                return Some(f.path.clone());
            }
            if !from_dir.is_empty() {
                if let Some(rel) = normalize(&format!("{from_dir}/{lc}")) {
                    if let Some(f) = self.files.get(&rel) {
                        return Some(f.path.clone());
                    }
                }
            }
            let Some(norm) = norm else { continue };
            if let Some(list) = self.by_name.get(file_name(&norm)) {
                let suffix = format!("/{norm}");
                let best = list
                    .iter()
                    .filter(|p| **p == norm || p.ends_with(&suffix))
                    .min_by_key(|p| (parent(p) != from_dir, p.len(), p.as_str()));
                if let Some(b) = best {
                    return Some(self.files[b].path.clone());
                }
            }
        }
        None
    }

    pub fn meta(&mut self, path: &str) -> Option<NoteMeta> {
        self.ensure_links();
        let (_, d) = self.doc_by_path(path)?;
        let fe = &self.files[&lower(path)];
        let links = d
            .parsed
            .links
            .iter()
            .zip(d.resolved.iter())
            .map(|(l, r)| ResolvedLink {
                target: l.target.clone(),
                subpath: l.subpath.clone(),
                display: l.display.clone(),
                embed: l.embed,
                line: l.line,
                resolved: r.clone(),
            })
            .collect();
        let backlink_count = self.backrefs.get(&lower(path)).map_or(0, |v| v.len() as u32);
        Some(NoteMeta {
            path: d.path.clone(),
            title: title_of(&d.path).to_string(),
            frontmatter: d.parsed.frontmatter.clone(),
            aliases: d.parsed.aliases.clone(),
            tags: d.parsed.unique_tags().into_iter().map(String::from).collect(),
            headings: d.parsed.headings.clone(),
            block_ids: d.parsed.block_ids.clone(),
            tasks: d.parsed.tasks.clone(),
            word_count: d.parsed.word_count,
            char_count: d.content.chars().count() as u32,
            links,
            backlink_count,
            mtime: fe.mtime,
            size: fe.size,
        })
    }

    // ------------------------------------------------------------ enlaces

    pub fn backlinks(&mut self, path: &str) -> Vec<Backlink> {
        self.ensure_links();
        let key = lower(path);
        let Some(ids) = self.backrefs.get(&key) else { return vec![] };
        let mut out = Vec::new();
        for &id in ids {
            let Some(d) = self.docs[id as usize].as_ref() else { continue };
            if lower(&d.path) == key {
                continue;
            }
            let lines: Vec<&str> = d.content.split('\n').collect();
            let mut seen = HashSet::new();
            let mut mentions = Vec::new();
            for (l, r) in d.parsed.links.iter().zip(d.resolved.iter()) {
                if r.as_deref().map(lower).as_deref() == Some(key.as_str()) && seen.insert(l.line) {
                    let text = lines.get(l.line as usize).map_or("", |s| s.trim_end_matches('\r')).trim().to_string();
                    mentions.push(Mention { line: l.line, text });
                }
            }
            out.push(Backlink { source: d.path.clone(), mentions });
        }
        out.sort_by(|a, b| a.source.cmp(&b.source));
        out
    }

    /// Menciones del título/alias de la nota que aún no son enlaces.
    pub fn unlinked_mentions(&mut self, path: &str) -> Vec<Backlink> {
        self.ensure_links();
        let key = lower(path);
        let Some((target_id, d)) = self.doc_by_path(path) else { return vec![] };
        let mut names: Vec<String> = vec![fold(title_of(&d.path))];
        names.extend(d.parsed.aliases.iter().map(|a| fold(a)));
        names.retain(|n| n.chars().count() >= 2);
        if names.is_empty() {
            return vec![];
        }
        // Preselección de candidatos vía índice invertido.
        let mut candidates: HashSet<DocId> = HashSet::new();
        for n in &names {
            let toks: Vec<&str> = tokenize(n).collect();
            let mut set: Option<HashSet<DocId>> = None;
            for t in toks {
                let s: HashSet<DocId> = self.postings.get(t).map(|v| v.iter().map(|x| x.0).collect()).unwrap_or_default();
                set = Some(match set {
                    None => s,
                    Some(prev) => prev.intersection(&s).copied().collect(),
                });
            }
            candidates.extend(set.unwrap_or_default());
        }
        candidates.remove(&target_id);
        let mut out = Vec::new();
        for id in candidates {
            let Some(src) = self.docs[id as usize].as_ref() else { continue };
            let linked_lines: HashSet<u32> = src
                .parsed
                .links
                .iter()
                .zip(src.resolved.iter())
                .filter(|(_, r)| r.as_deref().map(lower).as_deref() == Some(key.as_str()))
                .map(|(l, _)| l.line)
                .collect();
            let mut mentions = Vec::new();
            for (ln, line) in src.content.split('\n').enumerate() {
                let ln = ln as u32;
                if ln < src.parsed.body_line || linked_lines.contains(&ln) {
                    continue;
                }
                let f = fold(line);
                if names.iter().any(|n| contains_word(&f, n)) {
                    mentions.push(Mention { line: ln, text: line.trim().to_string() });
                }
            }
            if !mentions.is_empty() {
                out.push(Backlink { source: src.path.clone(), mentions });
            }
        }
        out.sort_by(|a, b| a.source.cmp(&b.source));
        out
    }

    pub fn unresolved(&mut self) -> Vec<Unresolved> {
        self.ensure_links();
        let mut map: BTreeMap<String, Unresolved> = BTreeMap::new();
        for d in self.docs.iter().flatten() {
            for (l, r) in d.parsed.links.iter().zip(d.resolved.iter()) {
                if r.is_none() && !l.target.is_empty() {
                    let e = map.entry(lower(&l.target)).or_insert_with(|| Unresolved { target: l.target.clone(), sources: vec![], count: 0 });
                    e.count += 1;
                    if !e.sources.contains(&d.path) {
                        e.sources.push(d.path.clone());
                    }
                }
            }
        }
        map.into_values().collect()
    }

    pub fn tags(&self) -> Vec<TagCount> {
        let mut map: HashMap<String, (String, u32)> = HashMap::new();
        for d in self.docs.iter().flatten() {
            for t in d.parsed.unique_tags() {
                map.entry(lower(t)).or_insert_with(|| (t.to_string(), 0)).1 += 1;
            }
        }
        let mut v: Vec<TagCount> = map.into_values().map(|(tag, count)| TagCount { tag, count }).collect();
        v.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        v
    }

    pub fn tasks(&self, include_done: bool) -> Vec<VaultTask> {
        let mut v = Vec::new();
        for d in self.docs.iter().flatten() {
            for t in &d.parsed.tasks {
                if include_done || !t.done {
                    v.push(VaultTask { path: d.path.clone(), line: t.line, done: t.done, text: t.text.clone() });
                }
            }
        }
        v.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
        v
    }

    /// Claves de propiedades (frontmatter) con su frecuencia.
    pub fn property_keys(&self) -> Vec<TagCount> {
        let mut map: HashMap<String, u32> = HashMap::new();
        for d in self.docs.iter().flatten() {
            if let Some(serde_json::Value::Object(o)) = &d.parsed.frontmatter {
                for k in o.keys() {
                    *map.entry(k.clone()).or_default() += 1;
                }
            }
        }
        let mut v: Vec<TagCount> = map.into_iter().map(|(tag, count)| TagCount { tag, count }).collect();
        v.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        v
    }

    // ------------------------------------------------------------ búsqueda

    /// Sintaxis: `palabra`, `"frase exacta"`, `-excluir`, `tag:#x`, `path:carpeta`,
    /// `file:nombre`, `task:texto`. Todas las cláusulas se combinan con AND;
    /// las palabras también coinciden por prefijo.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let q = parse_query(query);
        if q.is_empty() {
            return vec![];
        }
        let n = self.n_docs.max(1) as f32;
        let avgdl = (self.total_len as f32 / n).max(1.0);
        let (k1, b) = (1.2f32, 0.75f32);

        let mut scores: Option<HashMap<DocId, f32>> = None;
        for term in &q.terms {
            let mut clause: HashMap<DocId, f32> = HashMap::new();
            let range = self.postings.range::<str, _>((std::ops::Bound::Included(term.as_str()), std::ops::Bound::Unbounded));
            for (t, posts) in range.take_while(|(t, _)| t.starts_with(term.as_str())).take(64) {
                let weight = if **t == **term { 1.0 } else { 0.6 };
                let df = posts.len() as f32;
                let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
                for &(id, tf) in posts {
                    let dl = self.docs[id as usize].as_ref().map_or(1, |d| d.len) as f32;
                    let tf = tf as f32;
                    let s = weight * idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * dl / avgdl));
                    let e = clause.entry(id).or_insert(0.0);
                    if s > *e {
                        *e = s;
                    }
                }
            }
            scores = Some(match scores {
                None => clause,
                Some(prev) => prev.into_iter().filter_map(|(id, s)| clause.get(&id).map(|c| (id, s + c))).collect(),
            });
        }
        let base: Vec<(DocId, f32)> = match scores {
            Some(m) => m.into_iter().collect(),
            None => (0..self.docs.len() as DocId).filter(|&i| self.docs[i as usize].is_some()).map(|i| (i, 0.0)).collect(),
        };

        let mut hits: Vec<(DocId, f32)> = Vec::new();
        for (id, mut score) in base {
            let d = self.docs[id as usize].as_ref().unwrap();
            if !self.passes_filters(d, &q) {
                continue;
            }
            for t in &q.terms {
                if d.title_folded.contains(t.as_str()) {
                    score += 2.0;
                }
            }
            hits.push((id, score));
        }
        hits.sort_by(|a, b| {
            b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| {
                let (da, db) = (self.docs[a.0 as usize].as_ref().unwrap(), self.docs[b.0 as usize].as_ref().unwrap());
                da.path.cmp(&db.path)
            })
        });
        hits.truncate(limit);

        let mut hl_terms: Vec<String> = q.terms.clone();
        hl_terms.extend(q.phrases.iter().cloned());
        hl_terms.extend(q.tasks.iter().cloned());
        hits.into_iter()
            .map(|(id, score)| {
                let d = self.docs[id as usize].as_ref().unwrap();
                let mut matches = Vec::new();
                if !hl_terms.is_empty() {
                    for (ln, line) in d.content.split('\n').enumerate() {
                        let f = fold(line);
                        if hl_terms.iter().any(|t| f.contains(t.as_str())) {
                            let text: String = line.trim().chars().take(240).collect();
                            matches.push(Mention { line: ln as u32, text });
                            if matches.len() >= 4 {
                                break;
                            }
                        }
                    }
                }
                SearchHit { path: d.path.clone(), title: title_of(&d.path).to_string(), score, matches, terms: hl_terms.clone() }
            })
            .collect()
    }

    fn passes_filters(&self, d: &Doc, q: &Query) -> bool {
        let lp = lower(&d.path);
        let tags: Vec<String> = d.parsed.unique_tags().into_iter().map(fold).collect();
        let has_tag = |t: &str| tags.iter().any(|x| x == t || x.starts_with(&format!("{t}/")));
        let folded = if q.phrases.is_empty() && q.neg_phrases.is_empty() { None } else { Some(fold(&d.content)) };
        let has_term = |t: &str| d.terms.iter().any(|(x, _)| &**x == t);

        q.phrases.iter().all(|p| folded.as_ref().unwrap().contains(p.as_str()))
            && !q.neg_phrases.iter().any(|p| folded.as_ref().unwrap().contains(p.as_str()))
            && !q.neg_terms.iter().any(|t| has_term(t))
            && q.tags.iter().all(|t| has_tag(t))
            && !q.neg_tags.iter().any(|t| has_tag(t))
            && q.paths.iter().all(|p| lp.contains(p.as_str()))
            && !q.neg_paths.iter().any(|p| lp.contains(p.as_str()))
            && q.files.iter().all(|f| fold(file_name(&d.path)).contains(f.as_str()))
            && q.tasks.iter().all(|t| d.parsed.tasks.iter().any(|x| fold(&x.text).contains(t.as_str())))
    }

    /// Selector rápido: coincidencia difusa sobre título, ruta y alias.
    pub fn quick_switch(&self, query: &str, limit: usize) -> Vec<SwitchHit> {
        let qf: Vec<char> = fold(query.trim()).chars().filter(|c| !c.is_whitespace()).collect();
        let mut hits: Vec<SwitchHit> = Vec::new();
        for f in self.files.values() {
            let is_note = f.doc.is_some();
            let title = title_of(&f.path);
            if qf.is_empty() {
                hits.push(SwitchHit { path: f.path.clone(), title: title.to_string(), alias: None, is_note, score: f.mtime as f32 });
                continue;
            }
            let mut best: Option<(f32, Option<String>)> = None;
            let consider = |best: &mut Option<(f32, Option<String>)>, s: Option<f32>, a: Option<String>| {
                if let Some(s) = s {
                    if best.as_ref().map_or(true, |(b, _)| s > *b) {
                        *best = Some((s, a));
                    }
                }
            };
            consider(&mut best, fuzzy_score(&qf, title).map(|s| s * 1.3), None);
            consider(&mut best, fuzzy_score(&qf, strip_md(&f.path)), None);
            if let Some(id) = f.doc {
                if let Some(d) = self.docs[id as usize].as_ref() {
                    for a in &d.parsed.aliases {
                        consider(&mut best, fuzzy_score(&qf, a).map(|s| s * 1.2), Some(a.clone()));
                    }
                }
            }
            if let Some((mut s, alias)) = best {
                if !is_note {
                    s -= 2.0;
                }
                hits.push(SwitchHit { path: f.path.clone(), title: title.to_string(), alias, is_note, score: s });
            }
        }
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.path.cmp(&b.path)));
        hits.truncate(limit);
        hits
    }

    // ------------------------------------------------------------ grafo

    pub fn graph(&mut self, opts: &GraphOptions) -> Graph {
        self.ensure_links();
        let mut g = Graph::default();
        let mut ids: HashMap<String, u32> = HashMap::new();
        let mut edges: HashSet<(u32, u32)> = HashSet::new();

        fn node(g: &mut Graph, ids: &mut HashMap<String, u32>, id: String, label: String, kind: &'static str) -> u32 {
            if let Some(&i) = ids.get(&id) {
                return i;
            }
            let i = g.nodes.len() as u32;
            g.nodes.push(GraphNode { id: id.clone(), label, kind, degree: 0 });
            ids.insert(id, i);
            i
        }

        for f in self.files.values() {
            if f.doc.is_some() {
                node(&mut g, &mut ids, f.path.clone(), title_of(&f.path).to_string(), "note");
            }
        }
        for d in self.docs.iter().flatten() {
            let a = ids[&d.path];
            for (l, r) in d.parsed.links.iter().zip(d.resolved.iter()) {
                let b = match r {
                    Some(p) => {
                        let fe = &self.files[&lower(p)];
                        if fe.doc.is_some() {
                            ids[&fe.path]
                        } else if opts.attachments {
                            node(&mut g, &mut ids, fe.path.clone(), title_of(&fe.path).to_string(), "attachment")
                        } else {
                            continue;
                        }
                    }
                    None if opts.unresolved && !l.target.is_empty() => {
                        node(&mut g, &mut ids, format!("unresolved:{}", lower(&l.target)), l.target.clone(), "unresolved")
                    }
                    None => continue,
                };
                if a != b {
                    edges.insert((a.min(b), a.max(b)));
                }
            }
            if opts.tags {
                for t in d.parsed.unique_tags() {
                    let b = node(&mut g, &mut ids, format!("tag:{}", lower(t)), format!("#{t}"), "tag");
                    edges.insert((a.min(b), a.max(b)));
                }
            }
        }
        for &(a, b) in &edges {
            g.nodes[a as usize].degree += 1;
            g.nodes[b as usize].degree += 1;
        }
        let mut e: Vec<[u32; 2]> = edges.into_iter().map(|(a, b)| [a, b]).collect();
        e.sort_unstable();
        g.edges = e;
        if !opts.orphans {
            g = filter_graph(&g, |n| n.degree > 0);
        }
        g
    }

    /// Vecindario de una nota hasta `depth` saltos.
    pub fn local_graph(&mut self, path: &str, depth: u32, opts: &GraphOptions) -> Graph {
        let mut o = opts.clone();
        o.orphans = true;
        let g = self.graph(&o);
        let Some(start) = g.nodes.iter().position(|n| n.id.eq_ignore_ascii_case(path)) else { return Graph::default() };
        let mut adj: Vec<Vec<u32>> = vec![vec![]; g.nodes.len()];
        for [a, b] in &g.edges {
            adj[*a as usize].push(*b);
            adj[*b as usize].push(*a);
        }
        let mut dist = vec![u32::MAX; g.nodes.len()];
        dist[start] = 0;
        let mut q = VecDeque::from([start as u32]);
        while let Some(n) = q.pop_front() {
            let dn = dist[n as usize];
            if dn >= depth {
                continue;
            }
            for &m in &adj[n as usize] {
                if dist[m as usize] == u32::MAX {
                    dist[m as usize] = dn + 1;
                    q.push_back(m);
                }
            }
        }
        let keep: Vec<bool> = dist.iter().map(|&d| d != u32::MAX).collect();
        let mut i = 0;
        filter_graph(&g, |_| {
            let k = keep[i];
            i += 1;
            k
        })
    }

    // ------------------------------------------------------------ renombrado

    /// Renombra/mueve un archivo en el índice y devuelve las notas cuyo
    /// contenido cambió al actualizar sus enlaces (el host debe escribirlas).
    pub fn rename(&mut self, old: &str, new: &str) -> Result<Vec<Edit>, String> {
        let ok = lower(old);
        let nk = lower(new);
        if !self.files.contains_key(&ok) {
            return Err(format!("No existe: {old}"));
        }
        if ok != nk && self.files.contains_key(&nk) {
            return Err(format!("Ya existe: {new}"));
        }
        if is_note_path(old) != is_note_path(new) {
            // Cambio de tipo: reinsertar.
            let content = self.content(old).map(String::from);
            let (mtime, size) = { let f = &self.files[&ok]; (f.mtime, f.size) };
            self.remove(old);
            match content {
                Some(c) if is_note_path(new) => self.upsert_note(new, c, mtime, size),
                Some(c) => self.add_file(new, mtime, c.len() as u64),
                None if is_note_path(new) => self.upsert_note(new, String::new(), mtime, size),
                None => self.add_file(new, mtime, size),
            }
            return Ok(vec![]);
        }
        self.ensure_links();

        let sources: Vec<DocId> = self.backrefs.get(&ok).cloned().unwrap_or_default();
        let mut plan: Vec<(DocId, Vec<usize>)> = Vec::new();
        for id in sources {
            if let Some(d) = self.docs[id as usize].as_ref() {
                let idxs: Vec<usize> = d
                    .resolved
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| r.as_deref().map(lower).as_deref() == Some(ok.as_str()))
                    .map(|(i, _)| i)
                    .collect();
                if !idxs.is_empty() {
                    plan.push((id, idxs));
                }
            }
        }

        // Mover la entrada.
        let mut fe = self.unregister_file(&ok).unwrap();
        fe.path = new.to_string();
        let doc_id = fe.doc;
        let (mtime, size) = (fe.mtime, fe.size);
        self.register_file(new, mtime, size, doc_id);
        if let Some(id) = doc_id {
            self.remove_postings(id);
            let d = self.docs[id as usize].as_mut().unwrap();
            d.path = new.to_string();
            d.title_folded = fold(title_of(new));
            let (terms, len) = index_terms(&d.content, &d.title_folded);
            d.terms = terms;
            d.len = len;
            self.add_postings(id);
        }
        self.links_dirty = true;

        let mut edits = Vec::new();
        for (id, idxs) in plan {
            let d = self.docs[id as usize].as_ref().unwrap();
            let mut reps: Vec<(usize, usize, String)> = idxs
                .iter()
                .map(|&i| {
                    let l = &d.parsed.links[i];
                    (l.target_start as usize, l.target_end as usize, self.link_text_for(l, new, &d.path))
                })
                .collect();
            reps.sort_by(|a, b| b.0.cmp(&a.0));
            let mut content = d.content.clone();
            for (s, e, t) in reps {
                content.replace_range(s..e, &t);
            }
            if content != d.content {
                edits.push(Edit { path: d.path.clone(), content });
            }
        }
        for e in &edits {
            let (m, _) = { let f = &self.files[&lower(&e.path)]; (f.mtime, f.size) };
            self.upsert_note(&e.path, e.content.clone(), m, e.content.len() as u64);
        }
        Ok(edits)
    }

    /// Mueve una carpeta completa. Devuelve (pares movidos, ediciones).
    pub fn rename_folder(&mut self, old: &str, new: &str) -> Result<(Vec<(String, String)>, Vec<Edit>), String> {
        let o = old.trim_end_matches('/');
        let n = new.trim_end_matches('/');
        let prefix = format!("{}/", lower(o));
        let paths: Vec<String> = self.files.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, f)| f.path.clone()).collect();
        let mut moved = Vec::new();
        let mut all_edits: Vec<Edit> = Vec::new();
        for p in paths {
            let np = format!("{n}/{}", &p[o.len() + 1..]);
            let edits = self.rename(&p, &np)?;
            for e in edits {
                all_edits.retain(|x| lower(&x.path) != lower(&e.path));
                all_edits.push(e);
            }
            // Ediciones previas cuyo archivo se acaba de mover.
            for e in all_edits.iter_mut() {
                if lower(&e.path) == lower(&p) {
                    e.path = np.clone();
                }
            }
            moved.push((p, np));
        }
        Ok((moved, all_edits))
    }

    fn link_text_for(&self, l: &LinkRef, new: &str, src: &str) -> String {
        let keep_ext = !is_note_path(new) || is_note_path(&l.target) || l.kind == LinkKind::Markdown;
        let full = if keep_ext { new } else { strip_md(new) };
        let name = file_name(full);
        let text = if !l.target.contains('/') && self.resolve(name, src).map(|p| lower(&p)) == Some(lower(new)) {
            name.to_string()
        } else {
            full.to_string()
        };
        if l.kind == LinkKind::Markdown {
            percent_encode_path(&text)
        } else {
            text
        }
    }
}

fn filter_graph(g: &Graph, mut keep: impl FnMut(&GraphNode) -> bool) -> Graph {
    let mut map = vec![u32::MAX; g.nodes.len()];
    let mut out = Graph::default();
    for (i, n) in g.nodes.iter().enumerate() {
        if keep(n) {
            map[i] = out.nodes.len() as u32;
            out.nodes.push(GraphNode { degree: 0, ..n.clone() });
        }
    }
    for [a, b] in &g.edges {
        let (x, y) = (map[*a as usize], map[*b as usize]);
        if x != u32::MAX && y != u32::MAX {
            out.edges.push([x, y]);
            out.nodes[x as usize].degree += 1;
            out.nodes[y as usize].degree += 1;
        }
    }
    out
}

// ---------------------------------------------------------------- consultas

#[derive(Default, Debug)]
struct Query {
    terms: Vec<String>,
    neg_terms: Vec<String>,
    phrases: Vec<String>,
    neg_phrases: Vec<String>,
    tags: Vec<String>,
    neg_tags: Vec<String>,
    paths: Vec<String>,
    neg_paths: Vec<String>,
    files: Vec<String>,
    tasks: Vec<String>,
}

impl Query {
    fn is_empty(&self) -> bool {
        self.terms.is_empty()
            && self.neg_terms.is_empty()
            && self.phrases.is_empty()
            && self.neg_phrases.is_empty()
            && self.tags.is_empty()
            && self.neg_tags.is_empty()
            && self.paths.is_empty()
            && self.neg_paths.is_empty()
            && self.files.is_empty()
            && self.tasks.is_empty()
    }
}

fn split_query(q: &str) -> Vec<(String, bool)> {
    // (token, entrecomillado)
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut was_quoted = false;
    for c in q.chars() {
        match c {
            '"' => {
                if quoted {
                    quoted = false;
                    was_quoted = true;
                } else {
                    quoted = true;
                }
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push((std::mem::take(&mut cur), was_quoted));
                }
                was_quoted = false;
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push((cur, was_quoted || quoted));
    }
    out
}

fn parse_query(q: &str) -> Query {
    let mut out = Query::default();
    for (tok, quoted) in split_query(q) {
        let (neg, tok) = match tok.strip_prefix('-') {
            Some(r) if !r.is_empty() => (true, r.to_string()),
            _ => (false, tok),
        };
        let lt = tok.to_lowercase();
        let (op, val) = match lt.find(':') {
            Some(i) if ["tag", "path", "file", "task"].contains(&&lt[..i]) => (&lt[..i], fold(&tok[i + 1..])),
            _ => ("", fold(&tok)),
        };
        if val.is_empty() {
            continue;
        }
        match (op, neg) {
            ("tag", false) => out.tags.push(val.trim_start_matches('#').to_string()),
            ("tag", true) => out.neg_tags.push(val.trim_start_matches('#').to_string()),
            ("path", false) => out.paths.push(val),
            ("path", true) => out.neg_paths.push(val),
            ("file", _) => out.files.push(val),
            ("task", _) => out.tasks.push(val),
            _ if quoted || val.contains(' ') => {
                if neg {
                    out.neg_phrases.push(val)
                } else {
                    out.phrases.push(val)
                }
            }
            _ => {
                for t in tokenize(&val) {
                    if neg {
                        out.neg_terms.push(t.to_string());
                    } else {
                        out.terms.push(t.to_string());
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Index {
        let mut ix = Index::new();
        ix.upsert_note("Inicio.md", "# Inicio\nVer [[Proyectos/Alfa]] y [[Beta]] y [[Fantasma]]. #hub\n![[foto.png]]".into(), 1.0, 0);
        ix.upsert_note("Proyectos/Alfa.md", "---\naliases: [El Alfa]\ntags: proyecto\n---\nNotas de canción. Enlace a [[Inicio]]\nMenciona Beta aquí.".into(), 2.0, 0);
        ix.upsert_note("Archivo/Beta.md", "Contenido beta [md](../Inicio.md)\n- [ ] tarea pendiente".into(), 3.0, 0);
        ix.add_file("adjuntos/foto.png", 1.0, 10);
        ix
    }

    #[test]
    fn resolves_like_obsidian() {
        let ix = vault();
        assert_eq!(ix.resolve("Beta", "Inicio.md").as_deref(), Some("Archivo/Beta.md"));
        assert_eq!(ix.resolve("proyectos/alfa", "x.md").as_deref(), Some("Proyectos/Alfa.md"));
        assert_eq!(ix.resolve("foto.png", "Inicio.md").as_deref(), Some("adjuntos/foto.png"));
        assert_eq!(ix.resolve("../Inicio.md", "Archivo/Beta.md").as_deref(), Some("Inicio.md"));
        assert!(ix.resolve("Fantasma", "Inicio.md").is_none());
    }

    #[test]
    fn backlinks_and_unresolved() {
        let mut ix = vault();
        let b = ix.backlinks("Inicio.md");
        let srcs: Vec<_> = b.iter().map(|x| x.source.as_str()).collect();
        assert_eq!(srcs, vec!["Archivo/Beta.md", "Proyectos/Alfa.md"]);
        let u = ix.unresolved();
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].target, "Fantasma");
        // Crear la nota resuelve el enlace pendiente.
        ix.upsert_note("Fantasma.md", "".into(), 4.0, 0);
        assert!(ix.unresolved().is_empty());
        assert_eq!(ix.backlinks("Fantasma.md").len(), 1);
    }

    #[test]
    fn unlinked() {
        let mut ix = vault();
        let m = ix.unlinked_mentions("Archivo/Beta.md");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].source, "Proyectos/Alfa.md");
    }

    #[test]
    fn search_works() {
        let ix = vault();
        let r = ix.search("cancion", 10);
        assert_eq!(r[0].path, "Proyectos/Alfa.md");
        assert_eq!(r[0].matches.len(), 1);
        assert_eq!(ix.search("canc", 10).len(), 1, "prefijo");
        assert_eq!(ix.search("tag:#proyecto", 10).len(), 1);
        assert_eq!(ix.search("\"contenido beta\"", 10)[0].path, "Archivo/Beta.md");
        assert_eq!(ix.search("inicio -beta", 10).iter().filter(|h| h.path == "Archivo/Beta.md").count(), 0);
        assert_eq!(ix.search("path:proyectos", 10).len(), 1);
        assert_eq!(ix.search("task:pendiente", 10).len(), 1);
        let mut ix = ix;
        ix.upsert_note("G.md", "texto #guía/sub".into(), 9.0, 0);
        assert_eq!(ix.search("tag:#guía", 10).len(), 1, "etiqueta con acento");
        assert_eq!(ix.search("tag:guia", 10).len(), 1, "sin acento y jerárquica");
    }

    #[test]
    fn quick_switcher() {
        let ix = vault();
        let r = ix.quick_switch("alfa", 5);
        assert_eq!(r[0].path, "Proyectos/Alfa.md");
        let r = ix.quick_switch("el alfa", 5);
        assert_eq!(r[0].alias.as_deref(), Some("El Alfa"));
    }

    #[test]
    fn rename_updates_links() {
        let mut ix = vault();
        let edits = ix.rename("Inicio.md", "Hub/Principal.md").unwrap();
        let mut paths: Vec<_> = edits.iter().map(|e| e.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["Archivo/Beta.md", "Proyectos/Alfa.md"]);
        let alfa = ix.content("Proyectos/Alfa.md").unwrap();
        assert!(alfa.contains("[[Principal]]"), "{alfa}");
        let beta = ix.content("Archivo/Beta.md").unwrap();
        assert!(beta.contains("[md](Hub/Principal.md)"), "{beta}");
        assert_eq!(ix.backlinks("Hub/Principal.md").len(), 2);
        // Adjuntos
        let e = ix.rename("adjuntos/foto.png", "img/mi foto.png").unwrap();
        assert!(e[0].content.contains("![[mi foto.png]]"));
    }

    #[test]
    fn rename_folder_moves_all() {
        let mut ix = vault();
        let (moved, edits) = ix.rename_folder("Proyectos", "Activos/Proyectos").unwrap();
        assert_eq!(moved.len(), 1);
        assert!(ix.content("Inicio.md").unwrap().contains("[[Activos/Proyectos/Alfa]]"));
        assert_eq!(edits.len(), 1);
    }

    #[test]
    fn graph_building() {
        let mut ix = vault();
        let g = ix.graph(&GraphOptions { unresolved: true, attachments: true, tags: true, orphans: true });
        assert!(g.nodes.iter().any(|n| n.kind == "unresolved"));
        assert!(g.nodes.iter().any(|n| n.kind == "tag"));
        let l = ix.local_graph("Archivo/Beta.md", 1, &GraphOptions::default());
        assert_eq!(l.nodes.len(), 2);
    }

    #[test]
    fn update_keeps_backrefs_incremental() {
        let mut ix = vault();
        ix.backlinks("Inicio.md");
        ix.upsert_note("Archivo/Beta.md", "ya no enlaza".into(), 5.0, 0);
        assert_eq!(ix.backlinks("Inicio.md").len(), 1);
        ix.upsert_note("Archivo/Beta.md", "vuelve [[Inicio]]".into(), 6.0, 0);
        assert_eq!(ix.backlinks("Inicio.md").len(), 2);
        assert!(ix.remove("Archivo/Beta.md"));
        assert_eq!(ix.backlinks("Inicio.md").len(), 1);
        assert!(ix.search("vuelve", 5).is_empty());
    }
}
