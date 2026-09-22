import type { AggregationCursor, Document, FindCursor, MongoClient } from 'mongodb';
import { QueryResult } from '../model';
import { Parser, ShellSyntaxError } from './literal';
import { ColumnModel, formatCell } from './values';

export interface ShellCall {
  name: string;
  args: unknown[];
}

export type ShellCommand =
  | { kind: 'show'; what: 'dbs' | 'collections' }
  | { kind: 'use'; database: string }
  | { kind: 'db'; calls: ShellCall[] }
  | { kind: 'collection'; collection: string; calls: ShellCall[] };

/** Parses one mongo shell command: db.users.find({...}).sort({...}).limit(10), db.getCollection("x")…, show dbs… */
export function parseShell(text: string): ShellCommand {
  const t = text.trim().replace(/;\s*$/, '');
  const show = /^show\s+(\w+)$/i.exec(t);
  if (show) {
    const w = show[1].toLowerCase();
    if (w === 'dbs' || w === 'databases') return { kind: 'show', what: 'dbs' };
    if (w === 'collections' || w === 'tables') return { kind: 'show', what: 'collections' };
    throw new ShellSyntaxError(`Unsupported: "show ${show[1]}"`);
  }
  const use = /^use\s+([\w-]+)$/i.exec(t);
  if (use) return { kind: 'use', database: use[1] };

  const p = new Parser(t);
  if (p.ident() !== 'db') p.fail('Commands must start with db. (e.g. db.users.find({}))');

  type Part = { prop: string } | { call: unknown[] };
  const parts: Part[] = [];
  for (;;) {
    if (p.eat('.')) parts.push({ prop: p.ident() ?? p.fail('Expected a name after "."') });
    else if (p.peek() === '[') {
      p.i++;
      parts.push({ prop: p.string() });
      p.expect(']');
    } else if (p.peek() === '(') parts.push({ call: p.args() });
    else break;
  }
  if (!p.atEnd()) p.fail('Unexpected trailing input');

  let collection: string | undefined;
  let k = 0;
  const first = parts[0];
  if (first && 'prop' in first && first.prop === 'getCollection' && parts[1] && 'call' in parts[1]) {
    collection = String(parts[1].call[0] ?? '');
    k = 2;
  } else {
    // Collect props up to the first call: db.system.profile.find() → collection "system.profile".
    const props: string[] = [];
    while (k < parts.length && 'prop' in parts[k]) props.push((parts[k++] as { prop: string }).prop);
    if (props.length === 0) p.fail('Expected a collection name or command');
    if (props.length > 1) {
      collection = props.slice(0, -1).join('.');
      k--; // the last prop is the method name
    } else if (k >= parts.length) {
      p.fail(`Expected a method call after db.${props[0]} (e.g. db.${props[0]}.find({}))`);
    } else {
      k--;
    }
  }

  const calls: ShellCall[] = [];
  while (k < parts.length) {
    const a = parts[k];
    const b = parts[k + 1];
    if (!('prop' in a) || !b || !('call' in b)) return p.fail('Invalid method chain (e.g. .sort({a: 1}).limit(10))');
    calls.push({ name: a.prop, args: b.call });
    k += 2;
  }
  if (!calls.length) p.fail('Expected a method call');
  return collection === undefined ? { kind: 'db', calls } : { kind: 'collection', collection, calls };
}

const obj = (v: unknown, what: string): Document => {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ShellSyntaxError(`${what} must be an object { … }`);
  return v as Document;
};

/** Documents → a result table. */
export function docsResult(docs: Document[], started: number, truncated = false, command?: string): QueryResult {
  const model = new ColumnModel();
  model.absorb(docs);
  const names = docs.length && !docs.some((d) => '_id' in d) ? model.names().filter((n) => n !== '_id') : model.names();
  const columns = model.gridColumns().filter((c) => names.includes(c.name));
  return {
    columns: columns.map((c) => ({ name: c.name, dataType: c.dataType })),
    rows: docs.map((d) => names.map((n) => formatCell(d[n]))),
    durationMs: Date.now() - started,
    truncated,
    command,
  };
}

const READ = { promoteValues: false } as const;

async function drain(cursor: FindCursor | AggregationCursor, max: number): Promise<{ docs: Document[]; truncated: boolean }> {
  const docs: Document[] = [];
  for await (const d of cursor) {
    if (docs.length >= max) {
      await cursor.close();
      return { docs, truncated: true };
    }
    docs.push(d);
  }
  return { docs, truncated: false };
}

/** Runs one mongo shell command against database `dbName`. */
export async function runShell(client: MongoClient, dbName: string, text: string, maxRows: number): Promise<QueryResult> {
  const started = Date.now();
  const cmd = parseShell(text);
  const db = client.db(dbName);

  if (cmd.kind === 'use') {
    throw new ShellSyntaxError('To switch database, click the connection name at the top of the file (or in the status bar).');
  }
  if (cmd.kind === 'show') {
    if (cmd.what === 'dbs') {
      const r = await client.db('admin').command({ listDatabases: 1, authorizedDatabases: true });
      return docsResult((r.databases as Document[]).map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty })), started);
    }
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    return docsResult(cols.map((c) => ({ name: c.name, type: c.type })).sort((a, b) => a.name.localeCompare(b.name)), started);
  }

  const [first, ...rest] = cmd.calls;
  const a = first.args;

  if (cmd.kind === 'db') {
    switch (first.name) {
      case 'runCommand':
        return docsResult([await db.command(obj(a[0], 'Command'))], started);
      case 'adminCommand':
        return docsResult([await client.db('admin').command(obj(a[0], 'Command'))], started);
      case 'getCollectionNames':
        return docsResult((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => ({ name: c.name })), started);
      case 'getCollectionInfos':
        return docsResult(await db.listCollections(obj(a[0], 'Filter')).toArray(), started);
      case 'createCollection':
        await db.createCollection(String(a[0]), obj(a[1], 'Options'));
        return docsResult([{ ok: 1, created: String(a[0]) }], started);
      case 'createView':
        await db.createCollection(String(a[0]), { viewOn: String(a[1]), pipeline: a[2] as Document[] });
        return docsResult([{ ok: 1, created: String(a[0]) }], started);
      case 'stats':
        return docsResult([await db.stats()], started);
      case 'version':
        return docsResult([{ version: (await db.admin().buildInfo()).version }], started);
      case 'dropDatabase':
        await db.dropDatabase();
        return docsResult([{ ok: 1, dropped: dbName }], started);
      case 'getName':
        return docsResult([{ name: dbName }], started);
    }
    throw new ShellSyntaxError(`Unsupported: db.${first.name}()`);
  }

  const coll = db.collection(cmd.collection);
  const summary = (doc: Document, affected: number | undefined, command: string): QueryResult => ({
    ...docsResult([doc], started, false, command),
    affectedRows: affected,
  });

  switch (first.name) {
    case 'find': {
      const cursor = coll.find(obj(a[0], 'Filter'), { ...READ, projection: a[1] ? obj(a[1], 'Projection') : undefined });
      let userLimit = 0;
      for (const c of rest) {
        const x = c.args[0];
        switch (c.name) {
          case 'sort':
            cursor.sort(obj(x, 'Sort'));
            break;
          case 'limit':
            userLimit = Number(x);
            cursor.limit(userLimit);
            break;
          case 'skip':
            cursor.skip(Number(x));
            break;
          case 'project':
          case 'projection':
            cursor.project(obj(x, 'Projection'));
            break;
          case 'hint':
            cursor.hint(x as Document);
            break;
          case 'collation':
            cursor.collation(obj(x, 'Collation') as never);
            break;
          case 'maxTimeMS':
            cursor.maxTimeMS(Number(x));
            break;
          case 'batchSize':
            cursor.batchSize(Number(x));
            break;
          case 'comment':
            cursor.comment(String(x));
            break;
          case 'allowDiskUse':
            cursor.allowDiskUse(x !== false);
            break;
          case 'count':
          case 'countDocuments':
            await cursor.close();
            return docsResult([{ count: await coll.countDocuments(obj(a[0], 'Filter')) }], started);
          case 'explain':
            return docsResult([await cursor.explain()], started);
          case 'toArray':
          case 'pretty':
            break;
          default:
            throw new ShellSyntaxError(`Unsupported: .${c.name}() after find()`);
        }
      }
      if (!userLimit || userLimit > maxRows) cursor.limit(maxRows + 1);
      const { docs, truncated } = await drain(cursor, maxRows);
      return docsResult(docs, started, truncated, 'find');
    }
    case 'findOne': {
      const doc = await coll.findOne(obj(a[0], 'Filter'), { ...READ, projection: a[1] ? obj(a[1], 'Projection') : undefined });
      return docsResult(doc ? [doc] : [], started, false, 'findOne');
    }
    case 'aggregate': {
      const cursor = coll.aggregate(a[0] as Document[], { ...READ, ...obj(a[1], 'Options') });
      if (rest.some((c) => c.name === 'explain')) return docsResult([await cursor.explain()], started);
      const { docs, truncated } = await drain(cursor, maxRows);
      return docsResult(docs, started, truncated, 'aggregate');
    }
    case 'count':
    case 'countDocuments':
      return docsResult([{ count: await coll.countDocuments(obj(a[0], 'Filter'), obj(a[1], 'Options')) }], started);
    case 'estimatedDocumentCount':
      return docsResult([{ count: await coll.estimatedDocumentCount() }], started);
    case 'distinct': {
      const values = await coll.distinct(String(a[0]), obj(a[1], 'Filter'));
      return docsResult(values.slice(0, maxRows).map((value) => ({ value })), started, values.length > maxRows);
    }
    case 'insertOne': {
      const r = await coll.insertOne(obj(a[0], 'Document'));
      return summary({ insertedId: r.insertedId }, 1, 'insertOne');
    }
    case 'insertMany': {
      if (!Array.isArray(a[0])) throw new ShellSyntaxError('insertMany expects an array of documents [ {…}, {…} ]');
      const r = await coll.insertMany(a[0] as Document[], obj(a[1], 'Options'));
      return summary({ insertedCount: r.insertedCount, insertedIds: Object.values(r.insertedIds) }, r.insertedCount, 'insertMany');
    }
    case 'updateOne':
    case 'updateMany': {
      const update = Array.isArray(a[1]) ? (a[1] as Document[]) : obj(a[1], 'Update');
      const r = await coll[first.name](obj(a[0], 'Filter'), update, obj(a[2], 'Options'));
      return summary({ matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, upsertedId: r.upsertedId }, r.modifiedCount, first.name);
    }
    case 'replaceOne': {
      const r = await coll.replaceOne(obj(a[0], 'Filter'), obj(a[1], 'Document'), obj(a[2], 'Options'));
      return summary({ matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, upsertedId: r.upsertedId }, r.modifiedCount, 'replaceOne');
    }
    case 'deleteOne':
    case 'deleteMany': {
      const r = await coll[first.name](obj(a[0], 'Filter'));
      return summary({ deletedCount: r.deletedCount }, r.deletedCount, first.name);
    }
    case 'findOneAndUpdate':
    case 'findOneAndReplace':
    case 'findOneAndDelete': {
      const opts = { ...obj(first.name === 'findOneAndDelete' ? a[1] : a[2], 'Options'), includeResultMetadata: false };
      const doc =
        first.name === 'findOneAndDelete'
          ? await coll.findOneAndDelete(obj(a[0], 'Filter'), opts)
          : first.name === 'findOneAndUpdate'
            ? await coll.findOneAndUpdate(obj(a[0], 'Filter'), obj(a[1], 'Update'), opts)
            : await coll.findOneAndReplace(obj(a[0], 'Filter'), obj(a[1], 'Document'), opts);
      return docsResult(doc ? [doc] : [], started, false, first.name);
    }
    case 'createIndex': {
      const name = await coll.createIndex(obj(a[0], 'Keys') as never, obj(a[1], 'Options'));
      return summary({ createdIndex: name }, undefined, 'createIndex');
    }
    case 'dropIndex':
      await coll.dropIndex(a[0] as string);
      return summary({ ok: 1, droppedIndex: a[0] as string }, undefined, 'dropIndex');
    case 'getIndexes':
    case 'indexes':
    case 'listIndexes':
      return docsResult(await coll.listIndexes().toArray(), started);
    case 'drop':
      await coll.drop();
      return summary({ ok: 1, dropped: cmd.collection }, undefined, 'drop');
    case 'renameCollection':
      await coll.rename(String(a[0]));
      return summary({ ok: 1, renamedTo: String(a[0]) }, undefined, 'renameCollection');
    case 'stats':
      return docsResult([await db.command({ collStats: cmd.collection })], started);
  }
  throw new ShellSyntaxError(`Unsupported: db.${cmd.collection}.${first.name}()`);
}
