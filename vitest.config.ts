import { configDefaults, defineConfig } from 'vitest/config'

// temp/ and experiments/ are gitignored scratch that may hold stray *.test.ts files.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.worktrees/**', 'temp/**', 'experiments/**'] },
})
