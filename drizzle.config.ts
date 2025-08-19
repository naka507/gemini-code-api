import type { Config } from 'drizzle-kit';

export default {
  schema: './src/utils/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite', // 'postgresql' | 'mysql' | 'sqlite'
  driver: 'd1',
  dbCredentials: {
    wranglerConfigPath: './wrangler.toml',
    dbName: 'gemini-code',
  },
} satisfies Config;

