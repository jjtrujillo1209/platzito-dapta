import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.PLATZITO_API ?? "http://localhost:8700";

export default defineConfig({
  plugins: [react()],
  build: {
    // El único chunk grande es el SDK de Retell (LiveKit, ~600 kB) y se carga con import() solo al probar voz.
    chunkSizeWarningLimit: 650,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/widget": api,
      "/widget.js": api,
      "/mcp": api,
    },
  },
});
