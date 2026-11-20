// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Build output and the gitignored release notes.
  globalIgnores(["dist/", "release/", "coverage/"]),
  {
    files: ["**/*.{js,cjs,mjs,ts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // tsconfig.json covers src/ but leaves out the tests and the Vite config; the
        // project service type-checks those two with default options.
        projectService: { allowDefaultProject: ["src/__tests__/*.ts", "vite.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The tests hand the API values of the wrong type on purpose, to check what it refuses,
    // and read package.json and other JSON untyped. The checks that catch a forgotten
    // `await`, like no-floating-promises, still apply.
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
]);
