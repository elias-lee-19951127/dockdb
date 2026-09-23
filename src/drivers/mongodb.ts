import { AnyBulkWriteOperation, BSON, BulkWriteResult, Document, MongoClient, MongoClientOptions, ObjectId } from 'mongodb';
import { CellValue, ConnectionConfig, QueryResult, Sort, TableRef } from '../model';
import { parseDocument, ShellSyntaxError } from '../mongo/literal';
import { runShell } from '../mongo/shell';
import { BsonTypeName, bsonType, ColumnModel, formatCell, parseCell, toShell } from '../mongo/values';
import { mongoFilterExample } from '../sql/filterExample';
import type { Edit } from '../sql/mutations';
import { AuthError, Driver, DriverTableInfo, RowMismatchError, TableAccess, TableMeta, TablePage } from './driver';

const { EJSON } = BSON;
const SYSTEM_DBS = new Set(['admin', 'config', 'local']);

export class MongoDriver implements Driver {
  readonly kind = 'mongodb' as const;
  readonly queryLanguage = 'mongo' as const;
  readonly hasSchemas = false;
  readonly defaultDatabase: string;
  /** Only replica sets / mongos support transactions; standalone servers do not. */
  supportsTransactions = false;
  private clientPromise: Promise<MongoClient> | undefined;

  constructor(private readonly config: ConnectionConfig, private readonly password: string | undefined) {
    this.defaultDatabase = config.database || 'test';
  }

  private uri(): string {
    const c = this.config;
    const auth = c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(this.password ?? '')}@` : '';
    const host = c.host || '127.0.0.1';
    const hosts = c.srv || host.includes(',') || /:\d+$/.test(host) ? host : `${host}:${c.port ?? 27017}`;
    return `mongodb${c.srv ? '+srv' : ''}://${auth}${hosts}/${c.options ? `?${c.options}` : ''}`;
  }

  client(): Promise<MongoClient> {
    this.clientPromise ??= (async () => {
      const c = this.config;
      const params = new URLSearchParams(c.options ?? '');
      const opts: MongoClientOptions = { appName: 'DockDB', serverSelectionTimeoutMS: 6000, connectTimeoutMS: 6000 };
      if (c.user && !params.has('authSource')) opts.authSource = c.authSource ?? 'admin';
      // Replica sets in containers usually advertise internal hostnames → connect to the node directly.
      if (!c.srv && !(c.host ?? '').includes(',') && !params.has('replicaSet') && !params.has('directConnection')) opts.directConnection = true;
      if (c.ssl && !params.has('tls') && !params.has('ssl')) {
        opts.tls = true;
        opts.tlsAllowInvalidCertificates = true;
      }
      const client = new MongoClient(this.uri(), opts);
      await client.connect();
      return client;
    })().catch((e) => {
      this.clientPromise = undefined;
      throw this.wrap(e);
    });
    return this.clientPromise;
  }

  private wrap(e: unknown): Error {
    const err = e as { code?: number; codeName?: string; name?: string; message?: string };
    if (err.code === 18 || err.codeName === 'AuthenticationFailed' || /Authentication failed/i.test(err.message ?? '')) {
      return new AuthError(err.message ?? 'Sai user/password');
    }
    if (err.code === 13 || err.codeName === 'Unauthorized') return new AuthError('MongoDB requires authentication');
    if (err.name === 'MongoServerSelectionError') {
      const where = this.config.srv ? this.config.host : `${this.config.host}:${this.config.port}`;
      const reason = /ECONNREFUSED/.test(err.message ?? '') ? 'the database is not running or the port is not published' : err.message;
      return new Error(`Cannot connect to MongoDB ${where} — ${reason}`);
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  /** Runs fn, turning server auth errors into AuthError. */
  async run<T>(fn: (client: MongoClient) => Promise<T>): Promise<T> {
    const client = await this.client();
    try {
      return await fn(client);
    } catch (e) {
      throw this.wrap(e);
    }
  }

  async ping(): Promise<string | undefined> {
    return this.run(async (client) => {
      const admin = client.db('admin');
      const hello = await admin.command({ hello: 1 }).catch(() => admin.command({ isMaster: 1 }));
      this.supportsTransactions = !!hello.setName || hello.msg === 'isdbgrid';
      // Auth enabled but not logged in → error 13 here → prompt for user/password.
      await admin.command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
      const info = await admin.command({ buildInfo: 1 }).catch(() => undefined);
      return info?.version as string | undefined;
    });
  }

  async listDatabases(includeSystem: boolean): Promise<string[]> {
    return this.run(async (client) => {
      const r = await client.db('admin').command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
      const names = new Set((r.databases as { name: string }[]).map((d) => d.name).filter((d) => includeSystem || !SYSTEM_DBS.has(d)));
      if (this.config.database) names.add(this.config.database);
      return [...names].sort((a, b) => Number(b === this.defaultDatabase) - Number(a === this.defaultDatabase) || a.localeCompare(b));
    }).catch(() => [this.defaultDatabase]);
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(database: string): Promise<DriverTableInfo[]> {
    return this.run(async (client) => {
      const db = client.db(database);
      const cols = (await db.listCollections({}, { nameOnly: false }).toArray())
        .filter((c) => !c.name.startsWith('system.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      return Promise.all(
        cols.map(async (c, i): Promise<DriverTableInfo> => {
          const isView = c.type === 'view';
          const estimatedRows = !isView && i < 100 ? await db.collection(c.name).estimatedDocumentCount().catch(() => undefined) : undefined;
          return { database, name: c.name, type: isView ? 'view' : 'table', estimatedRows };
        }),
      );
    });
  }

  query(database: string, text: string, _params?: CellValue[], maxRows = 1000): Promise<QueryResult> {
    return this.run((client) => runShell(client, database, text, maxRows));
  }

  openTable(table: TableRef): TableAccess {
    return new MongoTableAccess(this, table);
  }

  qualifiedName(table: TableRef): string {
    return table.name;
  }

  sampleQuery(table: TableRef): string {
    return `db.getCollection(${JSON.stringify(table.name)}).find({}).limit(100)`;
  }

  async close(): Promise<void> {
    const p = this.clientPromise;
    this.clientPromise = undefined;
    await (await p?.catch(() => undefined))?.close().catch(() => undefined);
  }
}

/** A document key = its _id as canonical Extended JSON → parses back to the exact type. */
const keyOf = (id: unknown) => EJSON.stringify(id as Document, { relaxed: false });
const fromKey = (key: CellValue) => EJSON.parse(key ?? 'null', { relaxed: false });

class MongoTableAccess implements TableAccess {
  private readonly model = new ColumnModel();
  /** Documents on the current page by key — to know a field's original type when editing. */
  private pageDocs = new Map<string, Document>();

  constructor(private readonly driver: MongoDriver, private readonly table: TableRef) {}

  private coll<T>(fn: (c: ReturnType<ReturnType<MongoClient['db']>['collection']>, client: MongoClient) => Promise<T>): Promise<T> {
    return this.driver.run((client) => fn(client.db(this.table.database).collection(this.table.name), client));
  }

  async meta(): Promise<TableMeta> {
    const sample = await this.coll((c) => c.find({}, { limit: 300, promoteValues: false }).toArray());
    this.model.absorb(sample);
    const view = this.table.type === 'view';
    const columns = this.model.gridColumns();
    return {
      columns,
      editable: !view,
      readOnlyReason: view ? 'Views cannot be edited directly' : undefined,
      sort: view ? null : { column: '_id', dir: 'asc' },
      filter: { lang: 'mongo', label: 'FILTER', placeholder: mongoFilterExample(columns) },
    };
  }

  /** Filter + plain-text search: case-insensitive match on string fields, or an exact _id / number. */
  private query(filter: string, search: string): Document {
    const query = parseDocument(filter);
    const term = search.trim();
    if (!term) return query;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const or: Document[] = this.model
      .names()
      .filter((n) => this.model.typeOf(n) === 'string' || this.model.typeOf(n) === undefined)
      .slice(0, 40)
      .map((n) => ({ [n]: { $regex: escaped, $options: 'i' } }));
    if (/^[0-9a-f]{24}$/i.test(term)) or.push({ _id: new ObjectId(term) });
    if (/^-?\d+(\.\d+)?$/.test(term)) {
      for (const n of this.model.names()) if (['int', 'long', 'double', 'decimal'].includes(this.model.typeOf(n) ?? '')) or.push({ [n]: Number(term) });
    }
    const searchQuery = { $or: or.length ? or : [{ _id: null }] };
    return Object.keys(query).length ? { $and: [query, searchQuery] } : searchQuery;
  }

  equalsFilter(column: string, value: string): string {
    return `{ ${JSON.stringify(column)}: ${JSON.stringify(value)} }`;
  }

  async page(filter: string, search: string, sort: Sort | null, limit: number, offset: number): Promise<TablePage> {
    const started = Date.now();
    const query = this.query(filter, search);
    const docs = await this.coll((c) =>
      c
        .find(query, { promoteValues: false, sort: sort ? { [sort.column]: sort.dir === 'asc' ? 1 : -1 } : undefined, skip: offset, limit: limit + 1 })
        .toArray(),
    );
    const page = docs.slice(0, limit);
    const newColumns = this.model.absorb(page);
    this.pageDocs = new Map(page.map((d) => [keyOf(d._id), d]));
    const names = this.model.names();
    return {
      rows: page.map((d) => names.map((n) => formatCell(d[n]))),
      keys: page.map((d) => [keyOf(d._id)]),
      hasMore: docs.length > limit,
      durationMs: Date.now() - started,
      columns: newColumns ? this.model.gridColumns() : undefined,
    };
  }

  count(filter: string, search: string): Promise<number> {
    const query = this.query(filter, search);
    return this.coll((c) => (Object.keys(query).length ? c.countDocuments(query, { maxTimeMS: 15000 }) : c.estimatedDocumentCount()));
  }

  private convert(column: string, text: CellValue, hint: BsonTypeName | undefined): unknown {
    try {
      return parseCell(text, hint);
    } catch (e) {
      throw new ShellSyntaxError(`Column "${column}": ${(e as Error).message}`);
    }
  }

  /** Turns grid edits into bulkWrite operations; validates types before anything is written. */
  private build(edits: Edit[]) {
    const ops: AnyBulkWriteOperation[] = [];
    const lines: string[] = [];
    const ids: unknown[] = [];
    let updates = 0;
    let deletes = 0;
    const target = `db.getCollection(${JSON.stringify(this.table.name)})`;
    for (const e of edits) {
      if (e.type === 'insert') {
        const doc: Document = {};
        for (const [col, text] of Object.entries(e.values)) doc[col] = this.convert(col, text, this.model.typeOf(col));
        ops.push({ insertOne: { document: doc } });
        lines.push(`${target}.insertOne(${toShell(doc, true)})`);
        continue;
      }
      const id = fromKey(e.key[0]);
      ids.push(id);
      if (e.type === 'delete') {
        deletes++;
        ops.push({ deleteOne: { filter: { _id: id } } });
        lines.push(`${target}.deleteOne({ _id: ${toShell(id)} })`);
        continue;
      }
      if ('_id' in e.set) throw new ShellSyntaxError('_id cannot be changed — use "Duplicate row" and delete the old one.');
      const original = this.pageDocs.get(e.key[0] ?? '');
      const $set: Document = {};
      for (const [col, text] of Object.entries(e.set)) {
        const old = original?.[col];
        $set[col] = this.convert(col, text, old !== null && old !== undefined ? bsonType(old) : this.model.typeOf(col));
      }
      updates++;
      ops.push({ updateOne: { filter: { _id: id }, update: { $set } } });
      lines.push(`${target}.updateOne({ _id: ${toShell(id)} }, { $set: ${toShell($set, true)} })`);
    }
    return { ops, lines, ids, updates, deletes };
  }

  preview(edits: Edit[]) {
    const title = this.driver.supportsTransactions
      ? 'Commands to run (in one transaction)'
      : 'Commands to run (standalone MongoDB has no transactions — DockDB checks every row still exists before writing)';
    return { title, text: this.build(edits).lines.join('\n') };
  }

  async save(edits: Edit[]): Promise<number> {
    const { ops, ids, updates, deletes } = this.build(edits);
    return this.coll(async (c, client) => {
      if (ids.length) {
        const found = await c.countDocuments({ _id: { $in: ids as never[] } });
        const missing = new Set(ids.map((id) => keyOf(id))).size - found;
        if (missing > 0) {
          throw new Error(`${missing} row(s) were deleted elsewhere and can no longer be changed. Nothing was saved — press Reload to see the latest data.`);
        }
      }
      const check = (r: BulkWriteResult) => {
        if (r.matchedCount !== updates || r.deletedCount !== deletes) throw new RowMismatchError(r.matchedCount + r.deletedCount);
        return r.insertedCount + r.matchedCount + r.deletedCount;
      };
      if (!this.driver.supportsTransactions) return check(await c.bulkWrite(ops, { ordered: true }));
      const session = client.startSession();
      try {
        let affected = 0;
        await session.withTransaction(async () => {
          affected = check(await c.bulkWrite(ops, { ordered: true, session }));
        });
        return affected;
      } finally {
        await session.endSession();
      }
    });
  }

  editorQuery(filter: string, limit: number): string {
    return `db.getCollection(${JSON.stringify(this.table.name)}).find(${filter.trim() || '{}'}).limit(${limit})`;
  }
}
