import { loadEnv } from './env';
import { connectDb, disconnectDb } from './db';
import { createApp } from './app';
import { ensureSeeded } from './seed/reset';

async function main(): Promise<void> {
  const env = loadEnv();
  await connectDb(env.MONGODB_URI, env.NODE_ENV);
  if (await ensureSeeded(env.AUTONOMY_MODE))
    console.log('[server] empty database: seeded demo data');
  const app = createApp(env);
  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (autonomy: ${env.AUTONOMY_MODE})`);
  });
  // Scheduled vendor calls: run overdue ones now (e.g. after the free tier woke up), then every
  // 2 minutes while awake. Production would also hit POST /api/jobs/run-due from a cron.
  app.locals.chains.kick();
  app.locals.chains.startTimer(2 * 60_000);

  const shutdown = (): void => {
    app.locals.chains.stopTimer();
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
