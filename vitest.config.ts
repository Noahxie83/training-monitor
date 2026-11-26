import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['tests/unit/**/*.test.ts', 'tests/store/**/*.test.ts', 'tests/simulations/**/*.test.ts', 'tests/transport/**/*.test.ts', 'tests/domain/**/*.test.ts', 'tests/ui/**/*.test.ts', 'tests/ui/**/*.test.tsx'] } });
