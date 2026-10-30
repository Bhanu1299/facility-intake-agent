import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { HealthResponse } from '@fia/shared';
import { createApp } from './app';
import { connectDb, disconnectDb } from './db';
import { loadEnv } from './env';

describe('app skeleton', () => {
  let mongo: MongoMemoryServer;
  const env = loadEnv({ NODE_ENV: 'test', AUTONOMY_MODE: 'propose' });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await connectDb(mongo.getUri(), 'test');
  });

  afterAll(async () => {
    await disconnectDb();
    await mongo.stop();
  });

  it('GET /api/health reports db connected and the autonomy mode', async () => {
    const res = await request(createApp(env)).get('/api/health').expect(200);
    const body = HealthResponse.parse(res.body);
    expect(body.db).toBe('connected');
    expect(body.autonomyMode).toBe('propose');
  });

  it('unknown /api routes return JSON 404', async () => {
    const res = await request(createApp(env)).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('loadEnv', () => {
  it('applies defaults and treats blank values as unset', () => {
    const env = loadEnv({ NODE_ENV: 'test', LLM_MODEL_SMALL: '', DEMO_RATE_LIMIT_PER_HOUR: '5' });
    expect(env.LLM_MODEL_SMALL).toBe('openai/gpt-oss-20b');
    expect(env.DEMO_RATE_LIMIT_PER_HOUR).toBe(5);
  });

  it('requires MONGODB_URI in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/MONGODB_URI/);
  });

  it('rejects an invalid autonomy mode', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', AUTONOMY_MODE: 'yolo' })).toThrow(/AUTONOMY_MODE/);
  });
});
