// src/utils/db/schema.ts
import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';

export const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  apiKeyHash: text('api_key_hash').notNull(),
  model: text('model').notNull(),
  ipAddress: text('ip_address'),
  statusCode: integer('status_code').notNull(),
  requestTimestamp: text('request_timestamp').notNull(),
  responseTimeMs: integer('response_time_ms').notNull(),
  isStream: blob('is_stream', { mode: 'boolean' }).default(false),
  userAgent: text('user_agent'),
  errorMessage: text('error_message'),
  requestUrl: text('request_url'),
  requestModel: text('request_model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
});
