import { defineConfig } from 'vite';

// Tauri espera un puerto fijo y no debe ocultar errores de Rust.
export default defineConfig({
  clearScreen: false,
  base: './',
  server: { port: 5173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
});
