/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Порт 8081 закреплён за песочницей решением проджекта (#12);
// адрес API приходит из VITE_API_BASE, дефолт живёт в src/api/client.ts.
export default defineConfig({
  plugins: [react()],
  server: { port: 8081, strictPort: true },
  preview: { port: 8081, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true, // auto-cleanup testing-library между тестами
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
