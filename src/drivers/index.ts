import { ConnectionConfig } from '../model';
import { Driver } from './driver';
import { MongoDriver } from './mongodb';
import { MssqlDriver } from './mssql';
import { MysqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';

export function createDriver(config: ConnectionConfig, password: string | undefined, wasmDir: string): Driver {
  switch (config.kind) {
    case 'postgres':
      return new PostgresDriver(config, password);
    case 'mysql':
      return new MysqlDriver(config, password);
    case 'sqlite':
      return new SqliteDriver(config, wasmDir);
    case 'mongodb':
      return new MongoDriver(config, password);
    case 'mssql':
      return new MssqlDriver(config, password);
  }
}

export * from './driver';
