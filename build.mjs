/**
 * dsh-switch build: host ESM bundle + client bundle wrapped for the DSH web
 * module loader (same shape the community plugins ship):
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ID = 'dsh-switch'

const watch = process.argv.includes('--watch')

await mkdirSync(join(root, 'lib'), { recursive: true })

/** Host half: ESM, runtime imports limited to schemastery (host provides @deepseek-ai/* and node builtins). */
const hostBuild = {
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  minify: false,
  external: ['schemastery', '@deepseek-ai/*'],
}

/** Client half: CJS bundle over the loader-provided require (react family only). */
const clientBuild = {
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  write: false,
}

if (watch) {
  const ctx = await build({ ...hostBuild, watch })
  await ctx.watch ?? ctx.dispose?.()
  const clientCtx = await build({ ...clientBuild, write: false, watch, plugins: [wrapPlugin()] })
  await clientCtx.watch ?? clientCtx.dispose?.()
  process.stderr.write('[dsh-switch] watching src/ …\n')
} else {
  await build(hostBuild)
  const client = await build(clientBuild)
  const code = client.outputFiles[0].text
  await writeClient(code)
  process.stderr.write('[dsh-switch] built lib/index.js and lib/client.js\n')
}

function wrapPlugin() {
  return {
    name: 'wrap-module-loader',
    setup(b) {
      b.onEnd(async (result) => {
        for (const file of result.outputFiles ?? []) {
          if (file.path.endsWith('.js')) await writeClient(file.text)
        }
      })
    },
  }
}

async function writeClient(code) {
  const out = join(root, 'lib/client.js')
  const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code}
\t\treturn module.exports;
\t}
});
`
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, wrapped, 'utf8')
}
