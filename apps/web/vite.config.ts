import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  // The SAM decoder worker pulls in onnxruntime-web, which uses dynamic
  // imports. Code-splitting workers requires ES module output — the default
  // "iife" format errors out with "UMD and IIFE output formats are not
  // supported for code-splitting builds".
  worker: {
    format: "es",
  },
  build: {
    // Route-level code-splitting: bucket heavy libraries into their own
    // chunks so the initial JS payload stays under 250 kB gzipped.
    // Each chunk is fetched on demand by the route that needs it.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // Pixi is only needed inside the annotate editor.
            if (id.includes("pixi.js") || id.includes("@pixi/")) {
              return "pixi";
            }
            // Recharts (and its d3-* / victory-* transitive deps) are
            // only used on the stats page.
            if (
              id.includes("/recharts/") ||
              id.includes("/d3-") ||
              id.includes("/victory-")
            ) {
              return "charts";
            }
            // onnxruntime-web is only used by the local SAM decoder.
            if (id.includes("onnxruntime-web")) {
              return "ort";
            }
            // lucide-react is tree-shakeable per-icon; group whatever
            // does end up in the initial bundle into its own chunk so
            // it can be cached independently from app code.
            if (id.includes("lucide-react")) {
              return "icons";
            }
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});
