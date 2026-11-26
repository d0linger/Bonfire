import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["web/*.js", "tests/*.mjs", "ops/*.mjs", "build.mjs", "eslint.config.mjs"],
    extends: [js.configs.recommended],
  },
  { files: ["web/*.js"], languageOptions: { globals: globals.browser } },
  { files: ["web/app.js"], languageOptions: { globals: { __BONFIRE_RENDER_BUILD__: "readonly" } } },
  { files: ["web/sw.js"], languageOptions: { globals: { ...globals.serviceworker, CACHE: "readonly", FILES: "readonly" } } },
  // Playwright tests run page.evaluate callbacks inside the browser.
  { files: ["tests/*.mjs"], languageOptions: { globals: globals.browser } },
  { files: ["tests/*.mjs", "ops/*.mjs", "build.mjs"], languageOptions: { globals: globals.node } },
]);
