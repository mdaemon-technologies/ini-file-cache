import typescript from "@rollup/plugin-typescript"
import commonjs from "@rollup/plugin-commonjs"
import terser from "@rollup/plugin-terser"
import pkg from "./package.json" assert { type: "json" }

export default [
  {
    input: "src/iniFileCache.ts",
    external: [ 'fs', 'path', '@mdaemon/emitter/dist/emitter.cjs' ],
    output: [
      { file: pkg.main, format: "cjs", exports: "default", name: "IniFileCache" },
      { file: pkg.module, format: "es", exports: "default", name: "IniFileCache" },
    ],
    plugins: [
      typescript(),
      commonjs(),
      terser()
    ]
  }
]
