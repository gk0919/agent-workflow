import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['bin/**/*.ts', 'scripts/**/*.ts', 'src/**/*.ts', 'tests/**/*.ts'],
  // CLI workers and resource locators resolve paths relative to their own module.
  unbundle: true,
  root: '.',
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node20',
  fixedExtension: false,
  deps: { neverBundle: true },
  dts: true,
  sourcemap: true,
  clean: true,
  report: false,
});
