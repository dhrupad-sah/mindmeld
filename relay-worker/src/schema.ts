/**
 * Schema upgrades for Durable Object SQLite. `CREATE TABLE IF NOT EXISTS` leaves an existing table
 * as it is, so a column added in a later version has to be added to tables created before it.
 */

/** Add `column` (with SQL type/default `decl`) to `table` unless it already has it. Rows already there get NULL (or the default). */
export function addColumnIfMissing(sql: SqlStorage, table: string, column: string, decl: string): void {
  const have = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column);
  if (!have) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
