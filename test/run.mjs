/**
 * Test runner: bundles the smoke + integration tests with esbuild and runs
 * them on the current Node runtime (any Node >= 22.19 with node:sqlite).
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

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
