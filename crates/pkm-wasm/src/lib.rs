//! API de `pkm-core` expuesta a JavaScript. Los resultados se serializan
//! como objetos JS nativos (serde-wasm-bindgen), sin pasar por JSON.

use pkm_core::{GraphOptions, Index};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub struct Engine {
    ix: Index,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { ix: Index::new() }
    }

    #[wasm_bindgen(js_name = upsertNote)]
    pub fn upsert_note(&mut self, path: &str, content: String, mtime: f64) {
        let size = content.len() as u64;
        self.ix.upsert_note(path, content, mtime, size);
    }

    #[wasm_bindgen(js_name = addFile)]
    pub fn add_file(&mut self, path: &str, mtime: f64, size: f64) {
        self.ix.add_file(path, mtime, size as u64);
    }

    pub fn remove(&mut self, path: &str) -> bool {
        self.ix.remove(path)
    }

    #[wasm_bindgen(js_name = removeFolder)]
    pub fn remove_folder(&mut self, folder: &str) -> Result<JsValue, JsError> {
        js(&self.ix.remove_folder(folder))
    }

    pub fn clear(&mut self) {
        self.ix.clear();
    }

    pub fn exists(&self, path: &str) -> bool {
        self.ix.exists(path)
    }

    pub fn content(&self, path: &str) -> Option<String> {
        self.ix.content(path).map(String::from)
    }

    pub fn files(&self) -> Result<JsValue, JsError> {
        js(&self.ix.files())
    }

    pub fn stats(&self) -> Result<JsValue, JsError> {
        js(&self.ix.stats())
    }

    pub fn resolve(&self, target: &str, from: &str) -> Option<String> {
        self.ix.resolve(target, from)
    }

    pub fn meta(&mut self, path: &str) -> Result<JsValue, JsError> {
        js(&self.ix.meta(path))
    }

    pub fn backlinks(&mut self, path: &str) -> Result<JsValue, JsError> {
        js(&self.ix.backlinks(path))
    }

    #[wasm_bindgen(js_name = unlinkedMentions)]
    pub fn unlinked_mentions(&mut self, path: &str) -> Result<JsValue, JsError> {
        js(&self.ix.unlinked_mentions(path))
    }

    pub fn unresolved(&mut self) -> Result<JsValue, JsError> {
        js(&self.ix.unresolved())
    }

    pub fn tags(&self) -> Result<JsValue, JsError> {
        js(&self.ix.tags())
    }

    pub fn tasks(&self, include_done: bool) -> Result<JsValue, JsError> {
        js(&self.ix.tasks(include_done))
    }

    #[wasm_bindgen(js_name = propertyKeys)]
    pub fn property_keys(&self) -> Result<JsValue, JsError> {
        js(&self.ix.property_keys())
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<JsValue, JsError> {
        js(&self.ix.search(query, limit))
    }

    #[wasm_bindgen(js_name = quickSwitch)]
    pub fn quick_switch(&self, query: &str, limit: usize) -> Result<JsValue, JsError> {
        js(&self.ix.quick_switch(query, limit))
    }

    pub fn graph(&mut self, opts: JsValue) -> Result<JsValue, JsError> {
        let o: GraphOptions = serde_wasm_bindgen::from_value(opts).unwrap_or_default();
        js(&self.ix.graph(&o))
    }

    #[wasm_bindgen(js_name = localGraph)]
    pub fn local_graph(&mut self, path: &str, depth: u32, opts: JsValue) -> Result<JsValue, JsError> {
        let o: GraphOptions = serde_wasm_bindgen::from_value(opts).unwrap_or_default();
        js(&self.ix.local_graph(path, depth, &o))
    }

    pub fn rename(&mut self, old: &str, new: &str) -> Result<JsValue, JsError> {
        let edits = self.ix.rename(old, new).map_err(|e| JsError::new(&e))?;
        js(&edits)
    }

    #[wasm_bindgen(js_name = renameFolder)]
    pub fn rename_folder(&mut self, old: &str, new: &str) -> Result<JsValue, JsError> {
        let r = self.ix.rename_folder(old, new).map_err(|e| JsError::new(&e))?;
        js(&r)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
