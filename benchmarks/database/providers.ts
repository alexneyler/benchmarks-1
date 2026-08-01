import type { DatabaseProviderConfig } from './types.js';
import { createPostgresClient } from './postgres.js';

export const databaseProviders: DatabaseProviderConfig[] = [
  {
    name: 'postgres',
    requiredEnvVars: ['DATABASE_POSTGRES_URL'],
    createClient: () => createPostgresClient(),
  },
  //
  // add providers above
];
