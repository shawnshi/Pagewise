import { invoke } from '@tauri-apps/api/core'

export interface SqlResult { rowsAffected: number; lastInsertId?: number }
type Transport = <T>(command: string, args: Record<string, unknown>) => Promise<T>

export function splitSqlStatements(sql: string): string[] {
  const result: string[] = []
  let current = ''
  let quote = ''
  let comment = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    const next = sql[i + 1]
    if (comment === '--') {
      if (c === '\n') { comment = ''; current += '\n' }
      continue
    }
    if (comment === '/*') {
      if (c === '*' && next === '/') { comment = ''; current += ' '; i++ }
      continue
    }
    if (quote) {
      current += c
      if (c === quote) {
        if (next === quote) { current += next; i++ } else quote = ''
      }
      continue
    }
    if ((c === '-' && next === '-') || (c === '/' && next === '*')) {
      comment = c + next; i++; continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    if (c === ';') {
      if (current.trim()) result.push(current.trim())
      current = ''
    } else current += c
  }
  if (quote || comment === '/*') throw new Error('Invalid SQL statement')
  if (current.trim()) result.push(current.trim())
  return result
}

/** Uses the same Android SQLite implementation as native settings/imports, never sqlx. */
export class NativeSqlDatabase {
  private readonly root: string
  private readonly transport: Transport

  constructor(root: string, transport: Transport = invoke) {
    this.root = root
    this.transport = transport
  }

  private request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    // No retries: an Activity change can lose an acknowledgement after a committed write.
    return this.transport<T>('native_state', { action, payload, libraryRoot: this.root })
  }

  async execute(sql: string, values: unknown[] = []): Promise<SqlResult> {
    const statements = splitSqlStatements(sql)
    if (!statements.length || (statements.length > 1 && values.length)) throw new Error('Invalid SQL statement')
    return statements.length === 1
      ? this.request<SqlResult>('sql.execute', { sql: statements[0], values })
      : this.request<SqlResult>('sql.batch', { statements })
  }

  async initialize(schema: string): Promise<void> {
    await this.request('sql.initialize', { statements: splitSqlStatements(schema) })
  }

  async select<T = unknown[]>(sql: string, values: unknown[] = []): Promise<T> {
    const statements = splitSqlStatements(sql)
    if (statements.length !== 1) throw new Error('Invalid SQL statement')
    return (await this.request<{ rows: T }>('sql.select', { sql: statements[0], values })).rows
  }

  classify(updates: readonly unknown[]): Promise<SqlResult> {
    return this.request<SqlResult>('sql.classify', { updates })
  }
}

export async function openNativeSqlDatabase(root: string, schema: string): Promise<NativeSqlDatabase> {
  const database = new NativeSqlDatabase(root)
  await database.initialize(schema)
  await database.select('SELECT 1 AS ready')
  return database
}
