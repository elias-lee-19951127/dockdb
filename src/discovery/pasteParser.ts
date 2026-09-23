import { DEFAULT_PORT, DbKind, DetectedDb } from '../model';
import { credentialsFromEnv, detectKind, parseDockerInspect } from './dockerInspect';

const URL_RE = /\b(?:jdbc:)?(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|sqlserver|mssql):\/\/[^\s'"`<>]+/gi;

/** MongoDB URLs may list several hosts (h1:27017,h2:27017), so URL() cannot parse them. */
export function parseMongoUrl(raw: string): DetectedDb | undefined {
  const m = /^mongodb(\+srv)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^/?]+)\/?([^?]*)(?:\?(.*))?$/i.exec(raw.trim());
  if (!m) return undefined;
  const [, srv, user, password, hosts, db, query] = m;
  const params = new URLSearchParams(query ?? '');
  const database = decodeURIComponent(db) || undefined;
  const single = !srv && !hosts.includes(',');
  const [host, portText] = single ? hosts.split(':') : [hosts, undefined];
  const port = single ? Number(portText || DEFAULT_PORT.mongodb) : undefined;
  return {
    id: `url:mongodb:${hosts}:${database ?? ''}`,
    name: `${srv ? hosts : single ? `${host}:${port}` : hosts.split(',')[0] + '…'}${database ? '/' + database : ''}`,
    kind: 'mongodb',
    host,
    port,
    srv: !!srv,
    user: user ? decodeURIComponent(user) : undefined,
    password: password !== undefined ? decodeURIComponent(password) : undefined,
    database,
    // Mongo URI spec: without authSource, authenticate against the database in the path.
    authSource: params.get('authSource') ?? database ?? 'admin',
    options: query || undefined,
    source: 'url',
  };
}

/** Parse connection URL: postgres://u:p@host:5432/db, mysql://…, jdbc:postgresql://…, sqlite:///path. */
export function parseConnectionUrl(raw: string): DetectedDb | undefined {
  const text = raw.trim().replace(/^jdbc:/i, '');
  if (/^mongodb(\+srv)?:/i.test(text)) return parseMongoUrl(text);
  if (/^sqlite:/i.test(text)) {
    const file = decodeURIComponent(text.replace(/^sqlite:(\/\/)?/i, ''));
    return file ? { id: `file:${file}`, name: file.split(/[\\/]/).pop() ?? file, kind: 'sqlite', file, source: 'url' } : undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const kind: DbKind | undefined = scheme.startsWith('postgres')
    ? 'postgres'
    : scheme === 'mysql' || scheme === 'mariadb'
      ? 'mysql'
      : scheme === 'sqlserver' || scheme === 'mssql'
        ? 'mssql'
        : undefined;
  if (!kind) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1';
  const port = url.port ? Number(url.port) : DEFAULT_PORT[kind];
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined;
  const user = url.username ? decodeURIComponent(url.username) : url.searchParams.get('user') ?? undefined;
  const password = url.password ? decodeURIComponent(url.password) : url.searchParams.get('password') ?? undefined;
  const sslmode = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl');
  return {
    id: `url:${kind}:${host}:${port}:${database ?? ''}`,
    name: `${host}:${port}${database ? '/' + database : ''}`,
    kind,
    host,
    port,
    user,
    password,
    database,
    ssl: !!sslmode && !['disable', 'false', '0'].includes(sslmode),
    source: 'url',
  };
}

/**
 * Accepts anything the user pastes: `docker inspect` output, a connection URL,
 * a docker-compose snippet, a `docker run -e … -p …` command, or a .env file.
 */
export function parsePastedText(text: string): DetectedDb[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const found = parseDockerInspect(JSON.parse(trimmed));
      if (found.length) return found;
    } catch {
      // not valid JSON → try the other formats
    }
  }

  const fromUrls = [...trimmed.matchAll(URL_RE)].map((m) => parseConnectionUrl(m[0])).filter((d): d is DetectedDb => !!d);
  if (fromUrls.length) return dedupe(fromUrls);

  const loose = parseLooseConfig(trimmed);
  return loose ? [loose] : [];
}

/** Heuristic for compose / docker run / .env: collect env vars + port mappings + image. */
export function parseLooseConfig(text: string): DetectedDb | undefined {
  const env: Record<string, string> = {};
  const envRe = /(?:^|\s|-e\s+|--env\s+|-\s+)["']?([A-Z][A-Z0-9_]*)["']?\s*[:=]\s*["']?([^"'\s#]*)["']?/gm;
  for (const m of text.matchAll(envRe)) env[m[1]] = m[2];

  const mappings: { host: number; container: number; ip?: string }[] = [];
  const portRe = /(?:-p\s+|--publish\s+|-\s+|^|\s)["']?(?:(\d+\.\d+\.\d+\.\d+):)?(\d{2,5}):(\d{2,5})(?:\/tcp)?["']?/gm;
  for (const m of text.matchAll(portRe)) mappings.push({ ip: m[1], host: Number(m[2]), container: Number(m[3]) });

  const image =
    /image:\s*["']?([^\s"']+)/.exec(text)?.[1] ??
    /\b((?:[\w.-]+\/)*(?:postgres\w*|postgis\w*|timescale\w*|mysql|mariadb|percona|mongo\w*|mssql\w*|azure-sql-edge)[\w./-]*(?::[\w.-]+)?)\b/i.exec(text)?.[1] ??
    '';
  const kind = detectKind(image, env, mappings.map((m) => m.container), true);
  if (!kind || kind === 'sqlite') return undefined;

  const mapping = mappings.find((m) => m.container === DEFAULT_PORT[kind]) ?? mappings[0];
  const port = mapping?.host ?? DEFAULT_PORT[kind];
  const host = mapping?.ip && mapping.ip !== '0.0.0.0' ? mapping.ip : '127.0.0.1';
  const creds = credentialsFromEnv(kind, env);
  const name = /container_name:\s*["']?([\w.-]+)/.exec(text)?.[1] ?? /--name[\s=]+([\w.-]+)/.exec(text)?.[1] ?? `${host}:${port}`;
  return { id: `paste:${kind}:${host}:${port}`, name, kind, host, port, ...creds, source: 'manual', image: image || undefined };
}

function dedupe(list: DetectedDb[]): DetectedDb[] {
  const seen = new Set<string>();
  return list.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}
