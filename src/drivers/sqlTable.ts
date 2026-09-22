import { CellValue, ColumnInfo, GridColumn, Sort, TableRef } from '../model';
import { buildStatements, chooseKeySpec, Edit, KeySpec, keySelectList, renderForPreview } from '../sql/mutations';
import { SqlDriver, TableAccess, TableMeta, TablePage } from './driver';

/** Columns searched by the plain-text Search box (casting very wide tables is slow). */
const MAX_SEARCH_COLUMNS = 40;

/** The grid on one SQL table: paged SELECTs, INSERT/UPDATE/DELETE on save. */
export class SqlTableAccess implements TableAccess {
  private columns: ColumnInfo[] = [];
  private keySpec: KeySpec | undefined;

  constructor(private readonly driver: SqlDriver, private readonly table: TableRef) {}

  async meta(): Promise<TableMeta> {
    const [columns, fks] = await Promise.all([this.driver.listColumns(this.table), this.driver.listForeignKeys(this.table).catch(() => [])]);
    this.columns = columns;
    this.keySpec = chooseKeySpec(this.driver.dialect, this.table, this.columns);
    const pk = this.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    const grid: GridColumn[] = this.columns.map((c) => {
      const fk = fks.find((f) => f.column === c.name);
      return fk ? { ...c, references: { table: fk.ref, column: fk.refColumn } } : c;
    });
    return {
      columns: grid,
      editable: !!this.keySpec,
      readOnlyReason: this.keySpec ? undefined : 'Views cannot be edited directly',
      sort: pk.length === 1 ? { column: pk[0], dir: 'asc' } : null,
      filter: {
        lang: 'sql',
        label: 'WHERE',
        placeholder: "e.g. id > 10 AND email LIKE '%@gmail.com'  (Enter to apply)",
        identQuote: this.driver.dialect.kind === 'mysql' ? '`' : '"',
      },
    };
  }

  /** WHERE clause combining the SQL filter and the plain-text search, with its parameters. */
  private where(filter: string, search: string): { sql: string; params: CellValue[] } {
    const d = this.driver.dialect;
    const parts: string[] = [];
    const params: CellValue[] = [];
    if (filter.trim()) parts.push(`(${filter})`);
    const term = search.trim();
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const cols = this.columns.slice(0, MAX_SEARCH_COLUMNS).map((c) => d.quoteIdent(c.name));
      const text = d.kind === 'mysql' ? 'CHAR' : 'TEXT';
      const op = d.kind === 'postgres' ? 'ILIKE' : 'LIKE';
      const esc = d.kind === 'mysql' ? '' : " ESCAPE '\\'";
      const ors = cols.map((c) => {
        params.push(like);
        return `CAST(${c} AS ${text}) ${op} ${d.placeholder(params.length)}${esc}`;
      });
      parts.push(`(${ors.join(' OR ')})`);
    }
    return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
  }

  private select(filter: string, search: string, sort: Sort | null, limit: number, offset: number, withKeys: boolean) {
    const d = this.driver.dialect;
    const cols = this.columns.map((c) => d.quoteIdent(c.name));
    const keyCols = withKeys && this.keySpec?.kind === 'pseudo' ? keySelectList(d, this.keySpec) : [];
    const where = this.where(filter, search);
    let sql = `SELECT ${[...keyCols, ...cols].join(', ')} FROM ${d.qualified(this.table)}${where.sql}`;
    if (sort) sql += ` ORDER BY ${d.quoteIdent(sort.column)} ${sort.dir.toUpperCase()}`;
    return { sql: `${sql} LIMIT ${limit} OFFSET ${offset}`, params: where.params };
  }

  async page(filter: string, search: string, sort: Sort | null, limit: number, offset: number): Promise<TablePage> {
    // Fetch one extra row to know whether there is a next page.
    const q = this.select(filter, search, sort, limit + 1, offset, true);
    const r = await this.driver.query(this.table.database, q.sql, q.params);
    const spec = this.keySpec;
    const hasPseudo = spec?.kind === 'pseudo';
    const page = r.rows.slice(0, limit);
    const rows = hasPseudo ? page.map((row) => row.slice(1)) : page;
    const keys = page.map((row, i) => {
      if (!spec) return [];
      if (spec.kind === 'pseudo') return [row[0]];
      return spec.columns.map((name) => rows[i][this.columns.findIndex((c) => c.name === name)]);
    });
    return { rows, keys, hasMore: r.rows.length > limit, durationMs: r.durationMs };
  }

  async count(filter: string, search: string): Promise<number> {
    const where = this.where(filter, search);
    const r = await this.driver.query(this.table.database, `SELECT COUNT(*) FROM ${this.driver.dialect.qualified(this.table)}${where.sql}`, where.params);
    return Number(r.rows[0]?.[0] ?? 0);
  }

  equalsFilter(column: string, value: string): string {
    return `${this.driver.dialect.quoteIdent(column)} = '${value.replace(/'/g, "''")}'`;
  }

  private statements(edits: Edit[]) {
    if (!this.keySpec) throw new Error('This table cannot be edited');
    return buildStatements(this.driver.dialect, this.table, this.keySpec, edits);
  }

  preview(edits: Edit[]) {
    return { title: 'SQL to run (in one transaction)', text: this.statements(edits).map(renderForPreview).join('\n') };
  }

  save(edits: Edit[]): Promise<number> {
    return this.driver.transaction(this.table.database, this.statements(edits));
  }

  editorQuery(filter: string, limit: number): string {
    return this.select(filter, '', null, limit, 0, false).sql + ';';
  }
}
