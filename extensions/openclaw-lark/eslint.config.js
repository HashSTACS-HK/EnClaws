/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * ESLint configuration for OpenClaw Feishu Plugin.
 */

import eslint from "@eslint/js";
import pluginImportX from "eslint-plugin-import-x";
import pluginN from "eslint-plugin-n";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "bin/", "test/"],
  },

  // ── Base rule sets ────────────────────────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Main ──────────────────────────────────────────────────────────────
  {
    files: ["**/*.ts"],
    plugins: {
      n: pluginN,
      "import-x": pluginImportX,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.nodeBuiltin,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Error prevention ──────────────────────────────────────────────
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      eqeqeq: ["warn", "always", { null: "never" }],

      // ── Type safety ───────────────────────────────────────────────────
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", disallowTypeAnnotations: false },
      ],

      // Prefer interface over type
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],

      // ── Best practices ────────────────────────────────────────────────
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "warn",

      // Internal functions rely on type inference; only exported API
      // surface requires explicit return types.
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "warn",

      // ── Import ordering ───────────────────────────────────────────────
      "import-x/no-duplicates": "error",
      "import-x/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
        },
      ],
      "sort-imports": ["error", { ignoreDeclarationSort: true }],

      // ── Node.js best practices ────────────────────────────────────────
      "n/prefer-node-protocol": "error",
      "n/no-unsupported-features/node-builtins": ["error", { version: ">=22.0.0" }],
      "n/no-extraneous-import": [
        "error",
        {
          allowModules: ["openclaw"],
        },
      ],
      "n/process-exit-as-throw": "error",
      "n/hashbang": "error",
    },
  },

  // ── Test files ─────────────────────────────────────────────────────────
  {
    files: ["tests/**/*.test.ts"],
    rules: {
      // Test files can use any expressions freely
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-console": "off",
    },
  },
);
