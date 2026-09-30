//! Host nativo (Windows, macOS, Linux, Android, iOS) basado en Tauri 2.
//!
//! Mantiene la bóveda en disco como carpeta de Markdown plano (100 %
//! compatible con Obsidian), el índice `pkm-core` en memoria y un vigilante
//! del sistema de archivos que sincroniza los cambios externos.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use pkm_core::{
    is_note_path, Backlink, Edit, FileInfo, Graph, GraphOptions, Index, NoteMeta, SearchHit, Stats, SwitchHit, TagCount,
    Unresolved, VaultTask,
};
use rayon::prelude::*;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

#[derive(Default)]
struct Inner {
    root: RwLock<Option<PathBuf>>,
    index: Mutex<Index>,
}

#[derive(Default)]
struct AppState {
    inner: Arc<Inner>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultInfo {
    root: String,
    name: String,
    files: Vec<FileInfo>,
    folders: Vec<String>,
    stats: Stats,
    elapsed_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangeEvent {
    changed: Vec<String>,
    removed: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenameResult {
    moved: Vec<(String, String)>,
    edited: Vec<String>,
}

// ------------------------------------------------------------------ utilidades

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn mtime_of(md: &fs::Metadata) -> f64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_millis() as f64)
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// Ruta relativa con `/`, o `None` si está fuera de la bóveda u oculta.
fn rel_path(root: &Path, p: &Path) -> Option<String> {
    let r = p.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in r.components() {
        let s = c.as_os_str().to_str()?;
        if s.starts_with('.') {
            return None;
        }
        parts.push(s.to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Convierte una ruta relativa de la bóveda en absoluta, rechazando `..` y rutas absolutas.
fn abs_path(root: &Path, rel: &str) -> CmdResult<PathBuf> {
    let p = Path::new(rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Ruta no válida: {rel}"));
    }
    Ok(root.join(p))
}

fn root_of(state: &State<AppState>) -> CmdResult<PathBuf> {
    state.inner.root.read().unwrap().clone().ok_or_else(|| "No hay ninguna bóveda abierta".to_string())
}

fn scan(root: &Path) -> (Vec<(String, String, f64, u64)>, Vec<(String, f64, u64)>, Vec<String>) {
    let mut notes = Vec::new();
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let walker = walkdir::WalkDir::new(root).follow_links(true).into_iter().filter_entry(|e| {
        e.depth() == 0 || !e.file_name().to_str().is_some_and(|s| s.starts_with('.') || s == "node_modules")
    });
    for e in walker.flatten() {
        let Some(rel) = rel_path(root, e.path()) else { continue };
        if e.file_type().is_dir() {
            folders.push(rel);
        } else if let Ok(md) = e.metadata() {
            if is_note_path(&rel) {
                notes.push((rel, e.path().to_path_buf(), mtime_of(&md), md.len()));
            } else {
                files.push((rel, mtime_of(&md), md.len()));
            }
        }
    }
    let notes: Vec<(String, String, f64, u64)> = notes
        .into_par_iter()
        .filter_map(|(rel, abs, m, s)| fs::read_to_string(&abs).ok().map(|c| (rel, c, m, s)))
        .collect();
    folders.sort();
    (notes, files, folders)
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("last_vault.txt"))
}

// ------------------------------------------------------------------ bóveda

#[tauri::command]
fn last_vault(app: AppHandle) -> Option<String> {
    let f = config_file(&app)?;
    let p = fs::read_to_string(f).ok()?;
    let p = p.trim().to_string();
    Path::new(&p).is_dir().then_some(p)
}

/// Bóveda por defecto dentro de los datos de la app (útil en Android/iOS).
#[tauri::command]
fn default_vault(app: AppHandle) -> CmdResult<String> {
    let d = app.path().document_dir().or_else(|_| app.path().app_data_dir()).map_err(err)?.join("Nexo Vault");
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d.to_string_lossy().to_string())
}

#[tauri::command]
fn open_vault(app: AppHandle, state: State<AppState>, path: String) -> CmdResult<VaultInfo> {
    let t0 = std::time::Instant::now();
    let root = fs::canonicalize(&path).map_err(err)?;
    if !root.is_dir() {
        return Err(format!("No es una carpeta: {path}"));
    }
    fs::create_dir_all(root.join(".pkm")).ok();
    let (notes, files, folders) = scan(&root);
    {
        let mut ix = state.inner.index.lock().unwrap();
        ix.clear();
        ix.bulk_insert(notes);
        for (p, m, s) in files {
            ix.add_file(&p, m, s);
        }
        // Precalcula resolución de enlaces en paralelo.
        let _ = ix.unresolved();
    }
    *state.inner.root.write().unwrap() = Some(root.clone());
    let _ = app.asset_protocol_scope().allow_directory(&root, true);
    if let Some(cf) = config_file(&app) {
        if let Some(parent) = cf.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(cf, root.to_string_lossy().as_bytes()).ok();
    }
    start_watcher(&app, &state, &root);

    let ix = state.inner.index.lock().unwrap();
    Ok(VaultInfo {
        name: root.file_name().map_or("Bóveda".into(), |n| n.to_string_lossy().to_string()),
        root: root.to_string_lossy().to_string(),
        files: ix.files(),
        folders,
        stats: ix.stats(),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

fn start_watcher(app: &AppHandle, state: &State<AppState>, root: &Path) {
    let inner = state.inner.clone();
    let app2 = app.clone();
    let root2 = root.to_path_buf();
    let deb = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        let mut seen = HashSet::new();
        let mut ix = inner.index.lock().unwrap();
        for ev in events {
            let Some(rel) = rel_path(&root2, &ev.path) else { continue };
            if !seen.insert(rel.clone()) {
                continue;
            }
            match fs::metadata(&ev.path) {
                Ok(md) if md.is_dir() => {
                    // Carpeta nueva/movida: indexar su contenido.
                    let (notes, files, _) = scan(&ev.path);
                    for (p, c, m, s) in notes {
                        let full = format!("{rel}/{p}");
                        if ix.content(&full) != Some(c.as_str()) {
                            ix.upsert_note(&full, c, m, s);
                            changed.push(full);
                        }
                    }
                    for (p, m, s) in files {
                        let full = format!("{rel}/{p}");
                        ix.add_file(&full, m, s);
                        changed.push(full);
                    }
                }
                Ok(md) => {
                    if is_note_path(&rel) {
                        if let Ok(c) = fs::read_to_string(&ev.path) {
                            if ix.content(&rel) != Some(c.as_str()) {
                                ix.upsert_note(&rel, c, mtime_of(&md), md.len());
                                changed.push(rel);
                            }
                        }
                    } else if !ix.exists(&rel) {
                        ix.add_file(&rel, mtime_of(&md), md.len());
                        changed.push(rel);
                    }
                }
                Err(_) => {
                    if ix.remove(&rel) {
                        removed.push(rel);
                    } else {
                        removed.extend(ix.remove_folder(&rel));
                    }
                }
            }
        }
        drop(ix);
        if !changed.is_empty() || !removed.is_empty() {
            let _ = app2.emit("vault-changed", ChangeEvent { changed, removed });
        }
    });
    if let Ok(mut d) = deb {
        if d.watcher().watch(root, RecursiveMode::Recursive).is_ok() {
            *state.watcher.lock().unwrap() = Some(d);
        }
    }
}

#[tauri::command]
fn list_files(state: State<AppState>) -> Vec<FileInfo> {
    state.inner.index.lock().unwrap().files()
}

#[tauri::command]
fn list_folders(state: State<AppState>) -> CmdResult<Vec<String>> {
    let root = root_of(&state)?;
    let mut v: Vec<String> = walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_str().is_some_and(|s| s.starts_with('.')))
        .flatten()
        .filter(|e| e.file_type().is_dir())
        .filter_map(|e| rel_path(&root, e.path()))
        .collect();
    v.sort();
    Ok(v)
}

// ------------------------------------------------------------------ archivos

#[tauri::command]
fn read_note(state: State<AppState>, path: String) -> CmdResult<String> {
    if let Some(c) = state.inner.index.lock().unwrap().content(&path) {
        return Ok(c.to_string());
    }
    let root = root_of(&state)?;
    fs::read_to_string(abs_path(&root, &path)?).map_err(err)
}

fn write_and_index(root: &Path, ix: &mut Index, path: &str, content: &str) -> CmdResult<()> {
    let abs = abs_path(root, path)?;
    if let Some(p) = abs.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    // Escritura atómica: archivo temporal + rename.
    let name = abs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = abs.with_file_name(format!(".{name}.pkm-tmp"));
    fs::write(&tmp, content).map_err(err)?;
    fs::rename(&tmp, &abs).map_err(err)?;
    if is_note_path(path) {
        ix.upsert_note(path, content.to_string(), now_ms(), content.len() as u64);
    } else {
        ix.add_file(path, now_ms(), content.len() as u64);
    }
    Ok(())
}

#[tauri::command]
fn write_note(state: State<AppState>, path: String, content: String) -> CmdResult<()> {
    let root = root_of(&state)?;
    let mut ix = state.inner.index.lock().unwrap();
    write_and_index(&root, &mut ix, &path, &content)
}

#[tauri::command]
fn write_binary(state: State<AppState>, path: String, data: Vec<u8>) -> CmdResult<()> {
    let root = root_of(&state)?;
    let abs = abs_path(&root, &path)?;
    if let Some(p) = abs.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    fs::write(&abs, &data).map_err(err)?;
    state.inner.index.lock().unwrap().add_file(&path, now_ms(), data.len() as u64);
    Ok(())
}

#[tauri::command]
fn read_binary(state: State<AppState>, path: String) -> CmdResult<Vec<u8>> {
    let root = root_of(&state)?;
    fs::read(abs_path(&root, &path)?).map_err(err)
}

#[tauri::command]
fn abs_file_path(state: State<AppState>, path: String) -> CmdResult<String> {
    let root = root_of(&state)?;
    Ok(abs_path(&root, &path)?.to_string_lossy().to_string())
}

#[tauri::command]
fn create_folder(state: State<AppState>, path: String) -> CmdResult<()> {
    let root = root_of(&state)?;
    fs::create_dir_all(abs_path(&root, &path)?).map_err(err)
}

/// Mueve a `.trash/` dentro de la bóveda (como Obsidian), en lugar de borrar.
#[tauri::command]
fn delete_path(state: State<AppState>, path: String) -> CmdResult<Vec<String>> {
    let root = root_of(&state)?;
    let abs = abs_path(&root, &path)?;
    let trash = root.join(".trash");
    fs::create_dir_all(&trash).map_err(err)?;
    let name = abs.file_name().ok_or("ruta vacía")?.to_string_lossy().to_string();
    let mut dest = trash.join(&name);
    let mut n = 1;
    while dest.exists() {
        dest = trash.join(format!("{n} {name}"));
        n += 1;
    }
    let is_dir = abs.is_dir();
    fs::rename(&abs, &dest).map_err(err)?;
    let mut ix = state.inner.index.lock().unwrap();
    Ok(if is_dir {
        ix.remove_folder(&path)
    } else {
        ix.remove(&path);
        vec![path]
    })
}

#[tauri::command]
fn rename_path(state: State<AppState>, old: String, new: String) -> CmdResult<RenameResult> {
    let root = root_of(&state)?;
    let (oa, na) = (abs_path(&root, &old)?, abs_path(&root, &new)?);
    if na.exists() && !oa.to_string_lossy().eq_ignore_ascii_case(&na.to_string_lossy()) {
        return Err(format!("Ya existe: {new}"));
    }
    if let Some(p) = na.parent() {
        fs::create_dir_all(p).map_err(err)?;
    }
    let is_dir = oa.is_dir();
    fs::rename(&oa, &na).map_err(err)?;
    let mut ix = state.inner.index.lock().unwrap();
    let (moved, edits): (Vec<(String, String)>, Vec<Edit>) = if is_dir {
        ix.rename_folder(&old, &new)?
    } else {
        (vec![(old.clone(), new.clone())], ix.rename(&old, &new)?)
    };
    let mut edited = Vec::new();
    for e in edits {
        let abs = abs_path(&root, &e.path)?;
        fs::write(&abs, &e.content).map_err(err)?;
        edited.push(e.path);
    }
    Ok(RenameResult { moved, edited })
}

/// Archivos de configuración de la bóveda (`.pkm/…`): ajustes, marcadores, espacio de trabajo.
#[tauri::command]
fn read_config(state: State<AppState>, name: String) -> CmdResult<Option<String>> {
    let root = root_of(&state)?;
    let p = abs_path(&root.join(".pkm"), &name)?;
    Ok(fs::read_to_string(p).ok())
}

#[tauri::command]
fn write_config(state: State<AppState>, name: String, content: String) -> CmdResult<()> {
    let root = root_of(&state)?;
    let p = abs_path(&root.join(".pkm"), &name)?;
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(err)?;
    }
    fs::write(p, content).map_err(err)
}

// ------------------------------------------------------------------ consultas

#[tauri::command]
fn search(state: State<AppState>, query: String, limit: usize) -> Vec<SearchHit> {
    state.inner.index.lock().unwrap().search(&query, limit)
}

#[tauri::command]
fn quick_switch(state: State<AppState>, query: String, limit: usize) -> Vec<SwitchHit> {
    state.inner.index.lock().unwrap().quick_switch(&query, limit)
}

#[tauri::command]
fn meta(state: State<AppState>, path: String) -> Option<NoteMeta> {
    state.inner.index.lock().unwrap().meta(&path)
}

#[tauri::command]
fn backlinks(state: State<AppState>, path: String) -> Vec<Backlink> {
    state.inner.index.lock().unwrap().backlinks(&path)
}

#[tauri::command]
fn unlinked_mentions(state: State<AppState>, path: String) -> Vec<Backlink> {
    state.inner.index.lock().unwrap().unlinked_mentions(&path)
}

#[tauri::command]
fn unresolved(state: State<AppState>) -> Vec<Unresolved> {
    state.inner.index.lock().unwrap().unresolved()
}

#[tauri::command]
fn tags(state: State<AppState>) -> Vec<TagCount> {
    state.inner.index.lock().unwrap().tags()
}

#[tauri::command]
fn tasks(state: State<AppState>, include_done: bool) -> Vec<VaultTask> {
    state.inner.index.lock().unwrap().tasks(include_done)
}

#[tauri::command]
fn property_keys(state: State<AppState>) -> Vec<TagCount> {
    state.inner.index.lock().unwrap().property_keys()
}

#[tauri::command]
fn graph(state: State<AppState>, opts: GraphOptions) -> Graph {
    state.inner.index.lock().unwrap().graph(&opts)
}

#[tauri::command]
fn local_graph(state: State<AppState>, path: String, depth: u32, opts: GraphOptions) -> Graph {
    state.inner.index.lock().unwrap().local_graph(&path, depth, &opts)
}

#[tauri::command]
fn resolve(state: State<AppState>, target: String, from: String) -> Option<String> {
    state.inner.index.lock().unwrap().resolve(&target, &from)
}

#[tauri::command]
fn stats(state: State<AppState>) -> Stats {
    state.inner.index.lock().unwrap().stats()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            last_vault,
            default_vault,
            open_vault,
            list_files,
            list_folders,
            read_note,
            write_note,
            write_binary,
            read_binary,
            abs_file_path,
            create_folder,
            delete_path,
            rename_path,
            read_config,
            write_config,
            search,
            quick_switch,
            meta,
            backlinks,
            unlinked_mentions,
            unresolved,
            tags,
            tasks,
            property_keys,
            graph,
            local_graph,
            resolve,
            stats,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Nexo PKM");
}
