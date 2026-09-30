//! Banco de pruebas sintético: `cargo run --release -p pkm-core --features parallel --example bench -- 20000`
use std::time::Instant;

use pkm_core::{GraphOptions, Index};

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(10_000);
    let words = ["conocimiento", "canción", "proyecto", "idea", "sistema", "memoria", "red", "grafo", "nota", "enlace", "rust", "rendimiento"];
    let items: Vec<(String, String, f64, u64)> = (0..n)
        .map(|i| {
            let mut body = format!("---\ntags: [t{}, área/{}]\n---\n# Nota {i}\n", i % 50, i % 7);
            for p in 0..8 {
                for w in 0..40 {
                    body.push_str(words[(i * 7 + p * 3 + w) % words.len()]);
                    body.push(' ');
                }
                body.push_str(&format!("[[Nota {}]] [[Nota {}#Sección]] #tema{}\n\n", (i * 31 + p) % n, (i + p + 1) % n, p));
            }
            (format!("Carpeta {}/Nota {i}.md", i % 20), body.clone(), i as f64, body.len() as u64)
        })
        .collect();
    let bytes: usize = items.iter().map(|x| x.1.len()).sum();

    let mut ix = Index::new();
    let t = Instant::now();
    ix.bulk_insert(items);
    let _ = ix.unresolved();
    println!("indexar {n} notas ({:.1} MB): {:?}", bytes as f64 / 1e6, t.elapsed());

    let t = Instant::now();
    let r = ix.search("conocimiento rendim", 50);
    println!("búsqueda BM25 + prefijo: {:?} ({} resultados)", t.elapsed(), r.len());

    let t = Instant::now();
    let r = ix.quick_switch("nt 123", 20);
    println!("selector rápido difuso: {:?} ({} resultados)", t.elapsed(), r.len());

    let t = Instant::now();
    let b = ix.backlinks("Carpeta 0/Nota 0.md");
    println!("retroenlaces: {:?} ({} fuentes)", t.elapsed(), b.len());

    let t = Instant::now();
    let g = ix.graph(&GraphOptions { orphans: true, ..Default::default() });
    println!("grafo completo: {:?} ({} nodos, {} aristas)", t.elapsed(), g.nodes.len(), g.edges.len());

    let t = Instant::now();
    ix.upsert_note("Carpeta 3/Nota 3.md", "editada [[Nota 9]]".into(), 0.0, 0);
    let _ = ix.backlinks("Carpeta 9/Nota 9.md");
    println!("edición incremental + retroenlaces: {:?}", t.elapsed());

    let t = Instant::now();
    let e = ix.rename("Carpeta 0/Nota 0.md", "Archivo/Nota cero.md").unwrap();
    println!("renombrar con reescritura de enlaces: {:?} ({} notas editadas)", t.elapsed(), e.len());
}
