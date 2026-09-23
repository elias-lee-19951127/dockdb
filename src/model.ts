export type DbKind = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'mssql';

export const KIND_LABEL: Record<DbKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  mssql: 'Microsoft SQL Server',
};

export const DEFAULT_PORT: Record<Exclude<DbKind, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
  mssql: 1433,
};

export type ConnectionSource = 'docker' | 'scan' | 'file' | 'manual' | 'url';

/** Connection settings (no password — passwords live in SecretStorage). */
export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  /** File path, SQLite only. */
  file?: string;
  ssl?: boolean;
  /** MongoDB: database to authenticate against (default admin). */
  authSource?: string;
  /** MongoDB: raw query string from the URL (replicaSet=…, tls=…). */
  options?: string;
  /** MongoDB: mongodb+srv:// URL. */
  srv?: boolean;
  /** How careful to be with this connection; unset → derived from host (see safetyOf). */
  safety?: 'dev' | 'protected' | 'readonly';
  source: ConnectionSource;
  containerName?: string;
  image?: string;
  /** Note shown in the UI, e.g. "port not published". */
  note?: string;
}

/** An auto-detected database — may carry a password taken from the container's env. */
export interface DetectedDb extends ConnectionConfig {
  password?: string;
}

export type CellValue = string | null;

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
  isAutoIncrement: boolean;
}

/** A column shown in the grid. */
export interface GridColumn {
  name: string;
  dataType?: string;
  isPrimaryKey?: boolean;
  nullable?: boolean;
  hasDefault?: boolean;
  isAutoIncrement?: boolean;
  /** Foreign key: the row this value points to. */
  references?: { table: TableRef; column: string };
}

export interface ForeignKey {
  column: string;
  ref: TableRef;
  refColumn: string;
}

export interface Sort {
  column: string;
  dir: 'asc' | 'desc';
}

export interface TableRef {
  database: string;
  schema?: string;
  name: string;
  type: 'table' | 'view';
}

export interface QueryResult {
  columns: { name: string; dataType?: string }[];
  rows: CellValue[][];
  /** Rows affected by INSERT/UPDATE/DELETE. */
  affectedRows?: number;
  command?: string;
  durationMs: number;
  truncated?: boolean;
}

export interface Statement {
  sql: string;
  params: CellValue[];
  /** If true the statement must affect exactly one row, otherwise roll back. */
  expectOneRow?: boolean;
}
