import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: import.meta.dirname,
  publicDir: false,
  base: "/management-assets/",
  plugins: [react(), tailwindcss(), { name: "management-ui-boundary", generateBundle(_options, bundle) {
    const inputs = [...new Set(Object.values(bundle).flatMap(chunk => chunk.type === "chunk" ? Object.keys(chunk.modules) : []))];
    const ui = path.resolve(import.meta.dirname, "src") + "/";
    const allowed = /^(?:management\/|components\/ui\/(?:button|badge|input|sheet)\.tsx$|components\/(?:StatusBadge|StatusGlyph)\.tsx$|lib\/(?:utils|status-colors|task-status-presentation)\.ts$|(?:index|motion-tokens)\.css)/;
    if (inputs.some(id => id.startsWith(ui) && !allowed.test(id.slice(ui.length)))) throw new Error("management_ui_dependency_refused");
    this.emitFile({ type: "asset", fileName: "management-ui-closure.json", source: JSON.stringify(inputs.map(id => id.startsWith(import.meta.dirname) ? path.relative(import.meta.dirname, id) : id.replace(/^.*node_modules\//, "node_modules/")), null, 2) });
  } }],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist-management", emptyOutDir: true, sourcemap: false, rollupOptions: { input: path.resolve(import.meta.dirname, "management.html") } },
});
