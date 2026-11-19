/** Narrow canonical client surface for independently packaged offline tools.
 * Unlike index.ts it loads no embedded PostgreSQL/backup lifecycle or server.
 * It adds no authority: callers still own DB identity and admission checks.
 */
export * from './client.js';
export * from './schema/index.js';
export * from './work-signals.js';
export { sql } from 'drizzle-orm';
