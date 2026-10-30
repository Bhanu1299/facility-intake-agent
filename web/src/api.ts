import { HealthResponse } from '@fia/shared';

/** Empty in dev (Vite proxies /api); the Render URL in production. */
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return HealthResponse.parse(await res.json());
}
