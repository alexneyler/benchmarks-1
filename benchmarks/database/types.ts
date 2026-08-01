export interface DatabaseDocument {
  id: string;
  name: string;
  payload: string;
  version: number;
}

export interface DatabaseClient {
  setup(): Promise<void>;
  create(doc: DatabaseDocument): Promise<void>;
  read(id: string): Promise<DatabaseDocument | null>;
  update(
    id: string,
    patch: Pick<DatabaseDocument, 'name' | 'payload' | 'version'>,
  ): Promise<void>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseProviderConfig {
  name: string;
  requiredEnvVars: string[];
  createClient: () => DatabaseClient;
  timeout?: number;
  database?: string;
}

export interface DatabaseTimingResult {
  createMs: number;
  readMs: number;
  updateMs: number;
  readAfterUpdateMs: number;
  deleteMs: number;
  totalMs: number;
  payloadBytes: number;
  error?: string;
}

export interface DatabaseStats {
  createMs: { median: number; p95: number; p99: number };
  readMs: { median: number; p95: number; p99: number };
  updateMs: { median: number; p95: number; p99: number };
  readAfterUpdateMs: { median: number; p95: number; p99: number };
  deleteMs: { median: number; p95: number; p99: number };
  totalMs: { median: number; p95: number; p99: number };
}

export interface DatabaseBenchmarkResult {
  provider: string;
  mode: 'database';
  database?: string;
  table: string;
  payloadBytes: number;
  iterations: DatabaseTimingResult[];
  summary: DatabaseStats;
  compositeScore?: number;
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
