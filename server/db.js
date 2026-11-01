import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { SCHEMA } from './schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEFAULT_DB_FILE = path.join(ROOT, 'train-tracker.db')

export function openDb(dbFile = DEFAULT_DB_FILE) {
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

// Lightweight additive migrations for pre-existing DBs. `CREATE TABLE IF NOT
// EXISTS` won't add columns to a table that already exists, so grow old tables
// here with guarded ALTER TABLE statements.
function migrate(db) {
  const cols = (table) =>
    new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))

  if (!cols('captures').has('width')) {
    db.exec(`ALTER TABLE captures ADD COLUMN width INTEGER`)
    db.exec(`ALTER TABLE captures ADD COLUMN height INTEGER`)
    db.exec(`ALTER TABLE captures ADD COLUMN fps REAL`)
    db.exec(`ALTER TABLE captures ADD COLUMN duration REAL`)
  }
  if (!cols('captures').has('name')) {
    db.exec(`ALTER TABLE captures ADD COLUMN name TEXT`)
  }
  if (!cols('captures').has('captured_at')) {
    db.exec(`ALTER TABLE captures ADD COLUMN captured_at TEXT`)
  }
  if (!cols('captures').has('rotation')) {
    db.exec(`ALTER TABLE captures ADD COLUMN rotation REAL`)
  }
  if (!cols('captures').has('recorded_at') && cols('captures').has('note')) {
    // Legacy: nothing to do, recorded_at is superseded by captured_at.
  }
}