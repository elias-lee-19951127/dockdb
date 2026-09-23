// Messages between the extension and the grid webview. Bundled into both sides.
import type { CellValue, DbKind, GridColumn, Sort } from '../model';
import type { Edit } from '../sql/mutations';

export type { CellValue, DbKind, Edit, GridColumn, Sort };

/** Language of the filter box: SQL (WHERE …) or a MongoDB filter ({ … }). */
export interface FilterSpec {
  lang: 'sql' | 'mongo';
  label: string;
  placeholder: string;
  identQuote?: '"' | '`' | '[';
}

export interface ResultItem {
  title: string;
  sql: string;
  columns: GridColumn[];
  rows: CellValue[][];
  affectedRows?: number;
  durationMs: number;
  truncated?: boolean;
  error?: string;
  hint?: string;
}

export type ToWebview =
  | {
      type: 'table-init';
      title: string;
      subtitle: string;
      columns: GridColumn[];
      editable: boolean;
      readOnlyReason?: string;
      pageSize: number;
      sort: Sort | null;
      filter: FilterSpec;
      kind: DbKind;
      safety: 'dev' | 'protected' | 'readonly';
      /** Pre-applied filter, e.g. when following a foreign key. */
      initialFilter?: string;
    }
  | { type: 'page'; rows: CellValue[][]; keys: CellValue[][]; offset: number; hasMore: boolean; durationMs: number; columns?: GridColumn[] }
  | { type: 'total'; total: number | null }
  | { type: 'results'; title: string; items: ResultItem[] }
  | { type: 'running'; title: string; sql: string }
  | { type: 'error'; message: string; hint?: string; detail?: string }
  | { type: 'apply-filter'; where: string }
  | { type: 'saved'; affected: number }
  | { type: 'sql-preview'; title: string; sql: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'load'; offset: number; where: string; search: string; sort: Sort | null }
  | { type: 'save'; edits: Edit[] }
  | { type: 'preview'; edits: Edit[] }
  | { type: 'open-query'; where: string }
  | { type: 'info'; message: string }
  | { type: 'open-ref'; column: string; value: string }
  | { type: 'change-safety' }
  | { type: 'client-error'; message: string };
