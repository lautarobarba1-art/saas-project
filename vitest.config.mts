import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Todos los archivos comparten el mismo Pool de conexiones contra
    // una sola base de test — correrlos en paralelo pisaría fixtures
    // entre sí sin necesitar un schema por archivo.
    fileParallelism: false,
    globals: true,
  },
});
