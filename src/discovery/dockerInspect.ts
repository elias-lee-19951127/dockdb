import { DEFAULT_PORT, DbKind, DetectedDb } from '../model';

/** The part of `docker inspect` output DockDB needs. */
export interface InspectContainer {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Env?: string[]; ExposedPorts?: Record<string, unknown> };
  State?: { Running?: boolean; Status?: string };
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
    Networks?: Record<string, { IPAddress?: string }>;
  };
  HostConfig?: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
}

const IMAGE_PATTERNS: [RegExp, DbKind][] = [
  [/postgres|postgis|timescale|pgvector|supabase\/postgres|paradedb|pgrouting/i, 'postgres'],
  [/mysql|mariadb|percona(?!.*mongo)/i, 'mysql'],
  [/mongo/i, 'mongodb'],
];

/** Images that are DB tools/UIs, not databases. */
const NOT_A_DATABASE = /mongo-express|adminer|phpmyadmin|pgadmin|exporter|mongoku|nosqlclient|dbgate|cloudbeaver/i;

/**
 * Detects the database kind from the image first, then the container port.
 * Guessing from env vars is only used for pasted text (`envFallback`): app containers
 * (backends, workers…) often carry POSTGRES_* just to connect to a DB, so it is unreliable.
 */
export function detectKind(image: string, env: Record<string, string>, containerPorts: number[], envFallback = false): DbKind | undefined {
  if (NOT_A_DATABASE.test(image)) return undefined;
  for (const [re, kind] of IMAGE_PATTERNS) if (re.test(image)) return kind;
  if (containerPorts.includes(5432)) return 'postgres';
  if (containerPorts.includes(3306)) return 'mysql';
  if (containerPorts.includes(27017)) return 'mongodb';
  if (!envFallback) return undefined;
  if (Object.keys(env).some((k) => k.startsWith('MONGO_INITDB_') || k.startsWith('MONGODB_'))) return 'mongodb';
  if (Object.keys(env).some((k) => k.startsWith('POSTGRES'))) return 'postgres';
  if (Object.keys(env).some((k) => k.startsWith('MYSQL_') || k.startsWith('MARIADB_'))) return 'mysql';
  return undefined;
}

export function envToRecord(env: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of env ?? []) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Derives user / password / database from env vars, following the conventions of popular images. */
export function credentialsFromEnv(kind: DbKind, env: Record<string, string>): { user?: string; password?: string; database?: string } {
  if (kind === 'postgres') {
    const user = env.POSTGRES_USER ?? env.POSTGRESQL_USERNAME ?? env.PGUSER ?? 'postgres';
    let password = env.POSTGRES_PASSWORD ?? env.POSTGRESQL_PASSWORD ?? env.PGPASSWORD;
    if (password === undefined && user === 'postgres') password = env.POSTGRESQL_POSTGRES_PASSWORD;
    if (password === undefined && (env.POSTGRES_HOST_AUTH_METHOD === 'trust' || env.ALLOW_EMPTY_PASSWORD === 'yes')) password = '';
    const database = env.POSTGRES_DB ?? env.POSTGRESQL_DATABASE ?? env.PGDATABASE ?? user;
    return { user, password, database };
  }
  if (kind === 'mysql') {
    const rootPw = env.MYSQL_ROOT_PASSWORD ?? env.MARIADB_ROOT_PASSWORD;
    const allowEmpty = isTruthy(env.MYSQL_ALLOW_EMPTY_PASSWORD) || isTruthy(env.MARIADB_ALLOW_EMPTY_ROOT_PASSWORD) || env.ALLOW_EMPTY_PASSWORD === 'yes';
    const database = env.MYSQL_DATABASE ?? env.MARIADB_DATABASE;
    // Prefer root: it can see every database.
    if (rootPw !== undefined) return { user: 'root', password: rootPw, database };
    if (allowEmpty) return { user: 'root', password: '', database };
    const user = env.MYSQL_USER ?? env.MARIADB_USER;
    const password = env.MYSQL_PASSWORD ?? env.MARIADB_PASSWORD;
    return { user: user ?? 'root', password, database };
  }
  if (kind === 'mongodb') {
    const database = env.MONGO_INITDB_DATABASE ?? env.MONGODB_DATABASE;
    if (env.MONGO_INITDB_ROOT_USERNAME) return { user: env.MONGO_INITDB_ROOT_USERNAME, password: env.MONGO_INITDB_ROOT_PASSWORD, database };
    // bitnami/mongodb: the root user is named "root" by default.
    if (env.MONGODB_ROOT_PASSWORD) return { user: env.MONGODB_ROOT_USER ?? 'root', password: env.MONGODB_ROOT_PASSWORD, database };
    if (env.MONGODB_USERNAME) return { user: env.MONGODB_USERNAME, password: env.MONGODB_PASSWORD, database };
    // No user declared → Mongo runs without authentication.
    return { database };
  }
  return {};
}

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'no' && v.toLowerCase() !== 'false';
}

function normalizeHost(hostIp: string | undefined): string {
  if (!hostIp || hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '[::]') return '127.0.0.1';
  return hostIp;
}

function imageVersion(image: string): string | undefined {
  const tag = image.split('@')[0].split('/').pop()?.split(':')[1];
  return tag && tag !== 'latest' ? tag : undefined;
}

export function fromInspectContainer(c: InspectContainer): DetectedDb | undefined {
  const image = c.Config?.Image ?? '';
  const env = envToRecord(c.Config?.Env);
  const ports = c.NetworkSettings?.Ports ?? c.HostConfig?.PortBindings ?? {};
  const exposed = new Set<number>();
  for (const key of [...Object.keys(c.Config?.ExposedPorts ?? {}), ...Object.keys(ports)]) {
    const [p, proto] = key.split('/');
    if (!proto || proto === 'tcp') exposed.add(Number(p));
  }
  const kind = detectKind(image, env, [...exposed]);
  if (!kind || kind === 'sqlite') return undefined;

  const containerPort = exposed.has(DEFAULT_PORT[kind]) || exposed.size === 0 ? DEFAULT_PORT[kind] : [...exposed][0];
  const binding = (ports[`${containerPort}/tcp`] ?? []).find((b) => b.HostPort);
  const containerName = (c.Name ?? c.Id?.slice(0, 12) ?? 'container').replace(/^\//, '');
  const creds = credentialsFromEnv(kind, env);

  let host: string;
  let port: number;
  let note: string | undefined;
  if (binding?.HostPort) {
    host = normalizeHost(binding.HostIp);
    port = Number(binding.HostPort);
  } else {
    // Port not published: only reachable via the internal IP (Linux), not with Docker Desktop.
    host = Object.values(c.NetworkSettings?.Networks ?? {}).find((n) => n.IPAddress)?.IPAddress ?? '127.0.0.1';
    port = containerPort;
    note = 'port not published to host';
  }
  if (c.State && c.State.Running === false) note = `container ${c.State.Status ?? 'stopped'}`;

  const version = imageVersion(image);
  return {
    id: `docker:${containerName}`,
    name: containerName,
    kind,
    host,
    port,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    source: 'docker',
    containerName,
    image: version ? `${image.split(':')[0].split('/').pop()} ${version}` : image,
    note,
  };
}

/** Takes `docker inspect` output (an array or a single object) and returns the databases found. */
export function parseDockerInspect(json: unknown): DetectedDb[] {
  const list = Array.isArray(json) ? json : [json];
  const out: DetectedDb[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const db = fromInspectContainer(item as InspectContainer);
    if (db) out.push(db);
  }
  return out;
}
