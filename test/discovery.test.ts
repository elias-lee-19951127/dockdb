import { describe, expect, it } from 'vitest';
import { parseDockerInspect } from '../src/discovery/dockerInspect';
import { parseConnectionUrl, parsePastedText } from '../src/discovery/pasteParser';

const pgContainer = {
  Id: 'abc123def4567890',
  Name: '/shop-db',
  Config: {
    Image: 'postgres:16-alpine',
    Env: ['POSTGRES_USER=shop', 'POSTGRES_PASSWORD=s3cr=t', 'POSTGRES_DB=shop_dev', 'PATH=/usr/bin'],
    ExposedPorts: { '5432/tcp': {} },
  },
  State: { Running: true },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55432' }, { HostIp: '::', HostPort: '55432' }] } },
};

describe('parseDockerInspect', () => {
  it('reads the published host/port and credentials from a postgres image env', () => {
    const [db] = parseDockerInspect([pgContainer]);
    expect(db).toMatchObject({
      kind: 'postgres',
      name: 'shop-db',
      host: '127.0.0.1',
      port: 55432,
      user: 'shop',
      password: 's3cr=t',
      database: 'shop_dev',
      source: 'docker',
      image: 'postgres 16-alpine',
    });
  });

  it('mysql: prefers root when MYSQL_ROOT_PASSWORD is set', () => {
    const [db] = parseDockerInspect({
      Name: '/mysql8',
      Config: { Image: 'mysql:8', Env: ['MYSQL_ROOT_PASSWORD=root', 'MYSQL_USER=app', 'MYSQL_PASSWORD=app', 'MYSQL_DATABASE=app'] },
      NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '3307' }], '33060/tcp': null } },
    });
    expect(db).toMatchObject({ kind: 'mysql', port: 3307, user: 'root', password: 'root', database: 'app' });
  });

  it('mariadb with an empty root password', () => {
    const [db] = parseDockerInspect({
      Name: '/maria',
      Config: { Image: 'mariadb:11', Env: ['MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1'] },
      NetworkSettings: { Ports: { '3306/tcp': [{ HostIp: '0.0.0.0', HostPort: '3306' }] } },
    });
    expect(db).toMatchObject({ kind: 'mysql', user: 'root', password: '' });
  });

  it('mssql: reads the sa password from the official image env', () => {
    const [db] = parseDockerInspect({
      Name: '/sqlserver',
      Config: { Image: 'mcr.microsoft.com/mssql/server:2022-latest', Env: ['ACCEPT_EULA=Y', 'MSSQL_SA_PASSWORD=Str0ngPassw0rd!'] },
      NetworkSettings: { Ports: { '1433/tcp': [{ HostIp: '0.0.0.0', HostPort: '1433' }] } },
    });
    expect(db).toMatchObject({ kind: 'mssql', port: 1433, user: 'sa', password: 'Str0ngPassw0rd!' });
  });

  it('detects by port for unknown images and notes an unpublished port', () => {
    const [db] = parseDockerInspect({
      Name: '/custom',
      Config: { Image: 'mycorp/db:1', ExposedPorts: { '5432/tcp': {} } },
      NetworkSettings: { Ports: { '5432/tcp': null }, Networks: { bridge: { IPAddress: '172.17.0.3' } } },
    });
    expect(db).toMatchObject({ kind: 'postgres', host: '172.17.0.3', port: 5432, note: 'port not published to host', user: 'postgres' });
  });

  it('ignores containers that are not databases', () => {
    expect(parseDockerInspect([{ Name: '/web', Config: { Image: 'nginx' } }])).toEqual([]);
  });

  it('does not mistake an app container with POSTGRES_* env vars for a database', () => {
    const backend = {
      Name: '/ipo-backend',
      Config: { Image: 'ipo-ready-backend:dev', Env: ['POSTGRES_HOST=ipo-postgres', 'POSTGRES_USER=ipo_user', 'POSTGRES_PASSWORD=x'], ExposedPorts: { '8000/tcp': {} } },
      NetworkSettings: { Ports: { '8000/tcp': [{ HostIp: '0.0.0.0', HostPort: '8000' }] } },
    };
    expect(parseDockerInspect([backend])).toEqual([]);
  });

  it('postgres trust auth → empty password', () => {
    const [db] = parseDockerInspect({ Name: '/pg', Config: { Image: 'postgres', Env: ['POSTGRES_HOST_AUTH_METHOD=trust'] } });
    expect(db.password).toBe('');
  });
});

describe('parseConnectionUrl', () => {
  it('postgres URL with special characters', () => {
    expect(parseConnectionUrl('postgresql://me:p%40ss@db.local:6543/app?sslmode=require')).toMatchObject({
      kind: 'postgres',
      host: 'db.local',
      port: 6543,
      user: 'me',
      password: 'p@ss',
      database: 'app',
      ssl: true,
    });
  });
  it('jdbc mysql with the default port', () => {
    expect(parseConnectionUrl('jdbc:mysql://localhost/shop')).toMatchObject({ kind: 'mysql', port: 3306, database: 'shop' });
  });
  it('sqlserver URL with the default port', () => {
    expect(parseConnectionUrl('sqlserver://sa:p%40ss@localhost/app')).toMatchObject({
      kind: 'mssql',
      host: 'localhost',
      port: 1433,
      user: 'sa',
      password: 'p@ss',
      database: 'app',
    });
  });
  it('sqlite', () => {
    expect(parseConnectionUrl('sqlite:///tmp/app.db')).toMatchObject({ kind: 'sqlite', file: '/tmp/app.db' });
  });
});

describe('parsePastedText', () => {
  it('JSON docker inspect', () => {
    expect(parsePastedText(JSON.stringify([pgContainer]))).toHaveLength(1);
  });

  it('docker-compose', () => {
    const compose = `
services:
  db:
    image: postgres:15
    container_name: api-db
    environment:
      POSTGRES_USER: api
      POSTGRES_PASSWORD: "hunter2"
      POSTGRES_DB: api
    ports:
      - "5433:5432"
`;
    expect(parsePastedText(compose)[0]).toMatchObject({ kind: 'postgres', name: 'api-db', port: 5433, user: 'api', password: 'hunter2', database: 'api' });
  });

  it('compose with a list-style environment', () => {
    const compose = `
  mysql:
    image: mysql:8.0
    environment:
      - MYSQL_ROOT_PASSWORD=rootpw
      - MYSQL_DATABASE=blog
    ports:
      - 13306:3306`;
    expect(parsePastedText(compose)[0]).toMatchObject({ kind: 'mysql', port: 13306, user: 'root', password: 'rootpw', database: 'blog' });
  });

  it('docker run command', () => {
    const cmd = 'docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:5999:5432 postgres:16';
    expect(parsePastedText(cmd)[0]).toMatchObject({ kind: 'postgres', name: 'pg', host: '127.0.0.1', port: 5999, password: 'pw' });
  });

  it('.env with DATABASE_URL', () => {
    expect(parsePastedText('NODE_ENV=dev\nDATABASE_URL=postgres://u:p@localhost:5432/x\n')[0]).toMatchObject({ user: 'u', database: 'x' });
  });

  it('unrelated text', () => {
    expect(parsePastedText('hello world')).toEqual([]);
  });
});
