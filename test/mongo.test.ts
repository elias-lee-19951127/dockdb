import { BSONRegExp, Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { parseDockerInspect } from '../src/discovery/dockerInspect';
import { parsePastedText } from '../src/discovery/pasteParser';
import { parseDocument, parseLiteral } from '../src/mongo/literal';
import { parseShell } from '../src/mongo/shell';
import { splitMongo } from '../src/mongo/split';
import { bsonType, ColumnModel, formatCell, parseCell, toShell } from '../src/mongo/values';

describe('parseLiteral (mongo shell syntax)', () => {
  it('unquoted keys, single quotes, $ operators, regex, comments, trailing commas', () => {
    const v = parseDocument(`{ age: { $gt: 18, $lte: 65 }, name: /^an/i, 'tags': ['a', "b",], // comment
      nested: { "x.y": -1.5e2 } }`);
    expect(v.age).toEqual({ $gt: 18, $lte: 65 });
    expect(v.name).toBeInstanceOf(BSONRegExp);
    expect((v.name as BSONRegExp).options).toBe('i');
    expect(v.tags).toEqual(['a', 'b']);
    expect(v.nested).toEqual({ 'x.y': -150 });
  });

  it('BSON constructors', () => {
    const v = parseDocument(`{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718"), at: ISODate("2026-09-22T10:00:00Z"),
      n: NumberLong("9223372036854775807"), i: NumberInt(5), d: NumberDecimal("12.345"), when: new Date("2026-01-01") }`);
    expect(v._id).toBeInstanceOf(ObjectId);
    expect((v.at as Date).toISOString()).toBe('2026-09-22T10:00:00.000Z');
    expect(String(v.n)).toBe('9223372036854775807');
    expect(v.i).toBeInstanceOf(Int32);
    expect(v.d).toBeInstanceOf(Decimal128);
    expect(v.when).toBeInstanceOf(Date);
  });

  it('Extended JSON', () => {
    const v = parseDocument('{"_id": {"$oid": "64b7f0c2a1b2c3d4e5f60718"}, "n": {"$numberLong": "7"}}');
    expect(v._id).toBeInstanceOf(ObjectId);
    expect(v.n).toBeInstanceOf(Long);
  });

  it('readable errors', () => {
    expect(() => parseDocument('{ a: }')).toThrow(/Unexpected value/);
    expect(() => parseDocument('[1]')).toThrow(/must be an object/);
    expect(() => parseLiteral('{a: 1} x')).toThrow(/trailing input/);
    expect(() => parseLiteral('ObjectId("xyz")')).toThrow(/ObjectId/);
  });

  it('empty → {}', () => {
    expect(parseDocument('  ')).toEqual({});
  });
});

describe('parseShell', () => {
  it('find + a multi-line chain', () => {
    const c = parseShell(`db.users.find({ age: { $gt: 18 } }, { name: 1 })
      .sort({ age: -1 })
      .limit(10);`);
    expect(c).toMatchObject({ kind: 'collection', collection: 'users' });
    if (c.kind !== 'collection') throw new Error();
    expect(c.calls.map((x) => x.name)).toEqual(['find', 'sort', 'limit']);
    expect(c.calls[0].args).toEqual([{ age: { $gt: 18 } }, { name: 1 }]);
  });

  it('getCollection, db["x"], dotted collection names, db-level commands, show', () => {
    expect(parseShell('db.getCollection("order-items").countDocuments({})')).toMatchObject({ collection: 'order-items' });
    expect(parseShell("db['my coll'].findOne()")).toMatchObject({ collection: 'my coll' });
    expect(parseShell('db.system.profile.find()')).toMatchObject({ collection: 'system.profile' });
    expect(parseShell('db.runCommand({ ping: 1 })')).toMatchObject({ kind: 'db', calls: [{ name: 'runCommand' }] });
    expect(parseShell('show collections')).toEqual({ kind: 'show', what: 'collections' });
  });

  it('syntax errors', () => {
    expect(() => parseShell('users.find()')).toThrow(/must start with db/);
    expect(() => parseShell('db.users')).toThrow(/Expected a method call/);
  });
});

describe('splitMongo', () => {
  it('splits on lines starting with db., keeps multi-line chains, ignores ; and / inside strings/regexes', () => {
    const text = `// count
db.users.countDocuments({})
db.users.find({ name: /a;b\\/c/, note: "x; db.fake()" })
  .sort({ _id: -1 })

db.orders.aggregate([
  { $match: { total: { $gt: 1 } } },
]); db.a.findOne()`;
    const parts = splitMongo(text).map((s) => s.text);
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain('.sort({ _id: -1 })');
    expect(parts[3]).toBe('db.a.findOne()');
  });
});

describe('BSON values ↔ grid cells', () => {
  it('formatCell', () => {
    expect(formatCell(new ObjectId('64b7f0c2a1b2c3d4e5f60718'))).toBe('64b7f0c2a1b2c3d4e5f60718');
    expect(formatCell(new Date('2026-09-22T10:00:00Z'))).toBe('2026-09-22T10:00:00.000Z');
    expect(formatCell(new Int32(5))).toBe('5');
    expect(formatCell(Long.fromString('9223372036854775807'))).toBe('9223372036854775807');
    expect(formatCell({ a: [1, 'x'], ref: new ObjectId('64b7f0c2a1b2c3d4e5f60718') })).toBe('{"a":[1,"x"],"ref":ObjectId("64b7f0c2a1b2c3d4e5f60718")}');
    expect(formatCell(undefined)).toBeNull();
  });

  it('parseCell keeps the original type', () => {
    expect(parseCell('42', 'int')).toBeInstanceOf(Int32);
    expect(parseCell('4.5', 'int')).toBeInstanceOf(Double);
    expect(parseCell('42', 'double')).toBeInstanceOf(Double);
    expect(String(parseCell('9223372036854775806', 'long'))).toBe('9223372036854775806');
    expect(parseCell('false', 'bool')).toBe(false);
    expect(parseCell('00123', 'string')).toBe('00123');
    expect((parseCell('2026-01-02', 'date') as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(parseCell('ObjectId("64b7f0c2a1b2c3d4e5f60718")', 'objectId')).toBeInstanceOf(ObjectId);
    expect(parseCell('{a: 1, b: [ISODate("2026-01-01")]}', 'object')).toEqual({ a: 1, b: [new Date('2026-01-01')] });
    expect(() => parseCell('abc', 'int')).toThrow(/is not a number/);
    expect(() => parseCell('maybe', 'bool')).toThrow(/true\/false/);
  });

  it('parseCell guesses the type of new fields', () => {
    expect(parseCell('12', undefined)).toBe(12);
    expect(parseCell('0123', undefined)).toBe('0123'); // phone numbers stay strings
    expect(parseCell('true', undefined)).toBe(true);
    expect(parseCell('[1, 2]', undefined)).toEqual([1, 2]);
    expect(parseCell('xin chào', undefined)).toBe('xin chào');
  });

  it('formatCell → parseCell round-trips nested objects', () => {
    const v = { a: [1, 'x'], ref: new ObjectId('64b7f0c2a1b2c3d4e5f60718'), at: new Date('2026-01-01T00:00:00Z') };
    expect(parseCell(formatCell(v), bsonType(v))).toEqual(v);
  });

  it('toShell for previews', () => {
    expect(toShell({ n: Long.fromString('5'), d: new Decimal128('1.5') }, true)).toBe('{"n": NumberLong("5"), "d": NumberDecimal("1.5")}');
  });

  it('ColumnModel: _id first, dominant type, mixed', () => {
    const m = new ColumnModel();
    m.absorb([{ name: 'a', _id: new ObjectId(), age: 1 }, { _id: new ObjectId(), age: 'x', extra: null }]);
    expect(m.names()).toEqual(['_id', 'name', 'age', 'extra']);
    expect(m.typeOf('name')).toBe('string');
    expect(m.typeOf('age')).toBeUndefined();
    expect(m.gridColumns().map((c) => c.dataType)).toEqual(['objectId', 'string', 'mixed', 'null']);
    expect(m.absorb([{ _id: 1, newField: 2 }])).toBe(true);
  });
});

describe('MongoDB discovery', () => {
  it('docker inspect image mongo', () => {
    const [db] = parseDockerInspect({
      Name: '/mongo',
      Config: { Image: 'mongo:7', Env: ['MONGO_INITDB_ROOT_USERNAME=admin', 'MONGO_INITDB_ROOT_PASSWORD=pw', 'MONGO_INITDB_DATABASE=shop'] },
      NetworkSettings: { Ports: { '27017/tcp': [{ HostIp: '0.0.0.0', HostPort: '27018' }] } },
    });
    expect(db).toMatchObject({ kind: 'mongodb', port: 27018, user: 'admin', password: 'pw', database: 'shop' });
  });

  it('mongo without auth → no user', () => {
    const [db] = parseDockerInspect({ Name: '/m', Config: { Image: 'mongo' }, NetworkSettings: { Ports: { '27017/tcp': [{ HostPort: '27017' }] } } });
    expect(db.user).toBeUndefined();
  });

  it('ignores mongo-express (a UI, not a database)', () => {
    expect(parseDockerInspect({ Name: '/ui', Config: { Image: 'mongo-express', Env: ['ME_CONFIG_MONGODB_URL=mongodb://x'] } })).toEqual([]);
  });

  it('mongodb://, mongodb+srv:// and multi-host URLs', () => {
    expect(parsePastedText('MONGO_URL=mongodb://app:p%40ss@localhost:27019/shop?retryWrites=true')[0]).toMatchObject({
      kind: 'mongodb',
      host: 'localhost',
      port: 27019,
      user: 'app',
      password: 'p@ss',
      database: 'shop',
      authSource: 'shop',
    });
    expect(parsePastedText('mongodb+srv://u:p@cluster0.abc.mongodb.net/app?authSource=admin')[0]).toMatchObject({
      srv: true,
      host: 'cluster0.abc.mongodb.net',
      authSource: 'admin',
    });
    expect(parsePastedText('mongodb://h1:27017,h2:27017/?replicaSet=rs0')[0]).toMatchObject({ host: 'h1:27017,h2:27017', options: 'replicaSet=rs0' });
  });

  it('docker-compose mongo', () => {
    const compose = `
  mongo:
    image: mongo:6
    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: example
    ports:
      - "27020:27017"`;
    expect(parsePastedText(compose)[0]).toMatchObject({ kind: 'mongodb', port: 27020, user: 'root', password: 'example' });
  });
});
