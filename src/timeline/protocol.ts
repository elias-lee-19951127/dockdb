// Messages between the extension and the Query Timeline webview. Bundled into both sides.
import type { PlanSummary, TimelineQuery } from './analyze';

export type { PlanSummary, TimelineQuery };

export type ToTimeline =
  | {
      type: 'state';
      recording?: { connId: string; name: string; since: number };
      /** Connections that can be recorded. */
      candidates: { id: string; name: string }[];
      error?: string;
    }
  | { type: 'queries'; queries: TimelineQuery[]; reset?: boolean }
  | { type: 'explain'; id: number; summary?: PlanSummary; error?: string };

export type FromTimeline =
  | { type: 'ready' }
  | { type: 'start'; connId: string }
  | { type: 'stop' }
  | { type: 'clear' }
  | { type: 'explain'; id: number }
  | { type: 'open-sql'; id: number }
  | { type: 'open-table'; id: number; table: string }
  | { type: 'copy'; text: string }
  | { type: 'client-error'; message: string };
