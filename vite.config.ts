import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The renderer is a plain Vite + React app. `base: "./"` so the built files
// load from file:// inside the packaged app.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5199, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
