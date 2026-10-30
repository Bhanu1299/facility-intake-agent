import { loadEnv } from './env';
import { connectDb, disconnectDb } from './db';
import { createApp } from './app';

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDb(env.MONGODB_URI, env.NODE_ENV);
  const app = createApp(env);
  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (autonomy: ${env.AUTONOMY_MODE})`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void disconnectDb().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
