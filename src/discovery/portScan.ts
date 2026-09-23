import { execFile } from 'node:child_process';
import net from 'node:net';
import { DbKind } from '../model';

export interface ProbeResult {
  port: number;
  kind: DbKind;
  version?: string;
}

const COMMON_PORTS = [5432, 5433, 5434, 5435, 3306, 3307, 3308, 3309, 33060, 54320, 54321, 54322, 15432, 13306, 27017, 27018, 27019, 27020, 1433, 1434];

/** TCP ports listening on this machine (lsof on macOS/Linux, netstat on Windows). */
export function listListeningPorts(): Promise<number[]> {
  const [cmd, args] =
    process.platform === 'win32' ? ['netstat', ['-an', '-p', 'tcp']] : ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const ports = new Set<number>();
      const re = process.platform === 'win32' ? /:(\d+)\s+\S+\s+LISTENING/g : /:(\d+) \(LISTEN\)/g;
      for (const m of stdout.matchAll(re)) ports.add(Number(m[1]));
      resolve([...ports]);
    });
  });
}

// Postgres SSLRequest packet: length=8, code=80877103. The server answers 'S' or 'N'.
const PG_SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);

/**
 * Identifies the protocol spoken on a port:
 * - MySQL/MariaDB send a handshake as soon as you connect (protocol v10).
 * - Postgres stays silent; an SSLRequest gets exactly one byte back, 'S' or 'N'.
 */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<ProbeResult | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let stage: 'greeting' | 'pg' = 'greeting';
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r?: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(greetingTimer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    let greetingTimer: NodeJS.Timeout | undefined;

    socket.on('connect', () => {
      greetingTimer = setTimeout(() => {
        if (buf.length === 0) {
          stage = 'pg';
          socket.write(PG_SSL_REQUEST);
        }
      }, 250);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'pg') {
        const c = String.fromCharCode(buf[0]);
        return finish(buf.length === 1 && (c === 'S' || c === 'N') ? { port, kind: 'postgres' } : undefined);
      }
      if (buf.length < 5) return;
      const payloadLen = buf[0] | (buf[1] << 8) | (buf[2] << 16);
      if (payloadLen < 1 || payloadLen > 1024) return finish();
      const protocol = buf[4];
      if (protocol === 0xff) return finish({ port, kind: 'mysql' }); // error packet, vd "host is not allowed"
      if (protocol !== 10) return finish();
      const end = buf.indexOf(0, 5);
      if (end < 0) return;
      const version = buf.subarray(5, end).toString('latin1');
      finish(/^\d+\.\d+/.test(version) ? { port, kind: 'mysql', version: version.replace(/^5\.5\.5-/, '') } : undefined);
    });
    socket.on('error', () => finish());
    socket.on('close', () => finish());
  });
}

/** A `hello` command wrapped in OP_MSG (opcode 2013) — MongoDB always answers with OP_MSG. */
function mongoHello(): Buffer {
  // BSON { hello: 1, $db: "admin" }
  const doc = Buffer.concat([
    Buffer.from([0x10]), Buffer.from('hello\0'), int32(1),
    Buffer.from([0x02]), Buffer.from('$db\0'), int32(6), Buffer.from('admin\0'),
    Buffer.from([0x00]),
  ]);
  const bson = Buffer.concat([int32(doc.length + 4), doc]);
  const body = Buffer.concat([int32(0), Buffer.from([0x00]), bson]); // flagBits + section kind 0
  const header = Buffer.concat([int32(16 + body.length), int32(0x444f434b), int32(0), int32(2013)]);
  return Buffer.concat([header, body]);
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

export function probeMongo(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<ProbeResult | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r?: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('connect', () => socket.write(mongoHello()));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16) return;
      const responseTo = buf.readInt32LE(8);
      const opCode = buf.readInt32LE(12);
      finish(responseTo === 0x444f434b && (opCode === 2013 || opCode === 1) ? { port, kind: 'mongodb' } : undefined);
    });
    socket.on('error', () => finish());
    socket.on('close', () => finish());
  });
}

/**
 * Minimal TDS PRELOGIN request (MS-TDS). Any SQL Server answers with a PRELOGIN response
 * packet (header type 0x04) — that alone is enough to identify the protocol.
 */
function tdsPreLogin(): Buffer {
  const options: [number, Buffer][] = [
    [0x00, Buffer.from([0, 0, 0, 0, 0, 0])], // VERSION
    [0x01, Buffer.from([0x02])], // ENCRYPTION: NOT_SUPPORTED
    [0x02, Buffer.from([0x00])], // INSTOPT: no instance name
    [0x03, Buffer.from([0, 0, 0, 0])], // THREADID
    [0x04, Buffer.from([0x00])], // MARS: off
  ];
  const tokenBytes = options.length * 5 + 1; // + 0xFF terminator
  const tokens: Buffer[] = [];
  const data: Buffer[] = [];
  let offset = tokenBytes;
  for (const [token, value] of options) {
    const head = Buffer.alloc(5);
    head.writeUInt8(token, 0);
    head.writeUInt16BE(offset, 1);
    head.writeUInt16BE(value.length, 3);
    tokens.push(head);
    data.push(value);
    offset += value.length;
  }
  const body = Buffer.concat([...tokens, Buffer.from([0xff]), ...data]);
  const header = Buffer.alloc(8);
  header.writeUInt8(0x12, 0); // Type: PRELOGIN
  header.writeUInt8(0x01, 1); // Status: EOM
  header.writeUInt16BE(8 + body.length, 2); // Length
  return Buffer.concat([header, body]);
}

export function probeMssql(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<ProbeResult | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (r?: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('connect', () => socket.write(tdsPreLogin()));
    socket.on('data', (buf) => finish(buf.length >= 8 && buf[0] === 0x04 ? { port, kind: 'mssql' } : undefined));
    socket.on('error', () => finish());
    socket.on('close', () => finish());
  });
}

/** Probes listening + well-known ports and returns those speaking Postgres/MySQL/MongoDB/SQL Server. */
export async function scanPorts(extraPorts: number[] = []): Promise<ProbeResult[]> {
  const listening = await listListeningPorts();
  const candidates = [...new Set([...listening, ...COMMON_PORTS, ...extraPorts])]
    .filter((p) => p > 0 && p < 65536)
    .slice(0, 400);
  const results: ProbeResult[] = [];
  const queue = [...candidates];
  const workers = Array.from({ length: 24 }, async () => {
    for (let port = queue.shift(); port !== undefined; port = queue.shift()) {
      // Postgres/MySQL first; otherwise try MongoDB, then SQL Server, on a fresh connection.
      const r = (await probePort(port)) ?? (await probeMongo(port)) ?? (await probeMssql(port));
      if (r) results.push(r);
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.port - b.port);
}
