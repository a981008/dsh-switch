/**
 * Test runner: typechecks the sources, then bundles the smoke + integration
 * tests with esbuild and runs them on the current Node runtime (any Node >=
 * 22.19 with node:sqlite).
 *
 * The typecheck is not decoration: esbuild strips types without checking them,
 * and a wrong-shaped dependency object handed to the sync engine once shipped
 * as a silently failing automatic sync. `tsc --noEmit` catches exactly that.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const repo = join(root, '..')

const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
if (existsSync(tsc)) {
  const checked = spawnSync(process.execPath, [tsc, '--noEmit'], { stdio: 'inherit', cwd: repo })
  if (checked.status !== 0) {
    console.error('\nTypecheck failed — fix the errors above before running the tests.')
    process.exit(checked.status ?? 1)
  }
  console.log('Typecheck clean.')
} else {
  console.warn('typescript is not installed — skipping the typecheck (run pnpm install).')
}

for (const name of ['smoke', 'integration']) {
  const outfile = join(root, `${name}.mjs`)
  await build({
    entryPoints: [join(root, `${name}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
  })
  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
