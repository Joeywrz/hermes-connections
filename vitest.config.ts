import { defineConfig, mergeConfig } from 'vitest/config'
import path from 'node:path'
import { loadConfigFromFile } from 'vite'

const root = process.env.HERMES_SOURCE
if (!root) throw new Error('Set HERMES_SOURCE to a Hermes checkout with the Connections SDK and installed Desktop test dependencies.')
const sdkRoot = path.resolve(root, 'apps/desktop')
const desktop = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.join(sdkRoot, 'vite.config.ts'))
if (!desktop) throw new Error('Could not load Hermes Desktop Vite configuration')
export default mergeConfig(desktop.config, defineConfig({
  resolve: { alias: { '@hermes/plugin-sdk': path.join(sdkRoot, 'src/sdk/index.ts') } },
  test: {
    environment: 'jsdom',
    setupFiles: [path.join(sdkRoot, 'vitest.setup.ts')],
    include: ['desktop/*.test.ts'],
    testTimeout: 15000
  }
}))
