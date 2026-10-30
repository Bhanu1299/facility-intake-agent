import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDb, disconnectDb } from '../db';
import { loadEnv, type Env } from '../env';

/** In-memory MongoDB for a test file. Call in beforeAll / afterAll. */
export function useTestDb(): { env: Env } {
  let mongo: MongoMemoryServer;
  const env = loadEnv({
    NODE_ENV: 'test',
    AUTONOMY_MODE: 'propose',
    DEMO_RATE_LIMIT_PER_HOUR: '1000',
  });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await connectDb(mongo.getUri(), 'test');
  });

  afterAll(async () => {
    await disconnectDb();
    await mongo.stop();
  });

  return { env };
}
