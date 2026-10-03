// Cross-platform build orchestration: type-check (tsc -b), then bundle (vite).
//
// npm runs scripts through different shells (cmd / sh on CI / Windows
// PowerShell 5.1, which has no `&&`), so the two steps are spawned from node
// instead of chained with shell operators. This keeps `npm run build` working
// everywhere, including the PowerShell-based local environment.
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const tsc = fileURLToPath(new URL('./node_modules/typescript/bin/tsc', import.meta.url))
const vite = fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url))

for (const args of [
  [tsc, '-b'],
  [vite, 'build'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
