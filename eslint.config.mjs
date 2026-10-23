import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", ".cache/**"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        AbortController: "readonly",
      },
    },
  },
);
