import os from 'node:os';
import mongoose from 'mongoose';
import type { HealthResponse } from '@fia/shared';

let memoryServer: { stop: () => Promise<boolean> } | null = null;

/**
 * Connects to MONGODB_URI. In local dev with no URI, starts an in-memory MongoDB so the app
 * runs with zero setup (data is lost on restart). Never used in production.
 */
export async function connectDb(uri: string, nodeEnv: string): Promise<void> {
  let target = uri;
  if (!target) {
    if (nodeEnv === 'production') throw new Error('MONGODB_URI is required in production.');
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create();
    memoryServer = server;
    target = server.getUri('facility-intake-agent');
    console.warn('[db] MONGODB_URI not set: using in-memory MongoDB (data resets on restart).');
  }
  await mongoose.connect(target, {
    serverSelectionTimeoutMS: 10_000,
    // The driver otherwise loads `os` via dynamic import(), which fails silently under Jest and
    // sends an empty handshake that MongoDB 8 rejects. Passing it explicitly is equivalent.
    runtimeAdapters: { os },
  });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

const STATES: Record<number, HealthResponse['db']> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

export function dbState(): HealthResponse['db'] {
  return STATES[mongoose.connection.readyState] ?? 'disconnected';
}
