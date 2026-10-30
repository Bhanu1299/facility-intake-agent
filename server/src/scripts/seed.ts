import { loadEnv } from '../env';
import { connectDb, disconnectDb } from '../db';
import { resetDemoData } from '../seed/reset';

/** `npm run seed`: wipe and reload demo data in MONGODB_URI. */
async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.MONGODB_URI) {
    throw new Error('Set MONGODB_URI to seed a database (the in-memory dev DB seeds itself).');
  }
  await connectDb(env.MONGODB_URI, env.NODE_ENV);
  const summary = await resetDemoData(env.AUTONOMY_MODE);
  console.log('[seed] done', summary);
  await disconnectDb();
}

main().catch(async (err: unknown) => {
  console.error('[seed] failed', err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
