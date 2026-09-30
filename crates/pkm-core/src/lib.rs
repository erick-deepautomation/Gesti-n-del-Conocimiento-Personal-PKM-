//! `pkm-core`: núcleo compartido por la app de escritorio/móvil (Tauri, nativo)
//! y la versión web/PWA (WebAssembly). No hace E/S: el host le entrega el
//! contenido de los archivos y escribe las ediciones que devuelve.

pub mod index;
pub mod parser;
pub mod text;

pub use index::*;
pub use parser::{parse, ParsedNote};
