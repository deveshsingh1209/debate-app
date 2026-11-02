import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the built app with MOCK=1 (e2e/serve.mjs): the real
 * engine with scripted models, in a sandbox with no AI login and no keys. No
 * model call, no quota, and no request may leave 127.0.0.1 (fixtures.ts).
 *
 * One worker, files in order: they share one server, and 01-connect sets up
 * the doors the later files start debates on.
 */
const PORT = Number(process.env.E2E_PORT ?? 8871);

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  // The docs screenshots are opt-in: npm run e2e:shots.
  testIgnore: process.env.E2E_DOCS_SHOTS ? [] : [/docs-shots/],
  outputDir: '../.scratch/e2e-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // No service worker can make a request the route guard does not see.
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
