import { useEffect, useState } from 'react';

const KEY = 'fia.callAdminKey';
const EVENT = 'fia:admin-key';

/** The call admin key lives in sessionStorage only: gone when the tab closes. */
export function readAdminKey(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeAdminKey(key: string | null): void {
  try {
    if (key) sessionStorage.setItem(KEY, key);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked (private mode): the key just won't persist.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useAdminKey(): string | null {
  const [key, setKey] = useState(readAdminKey);
  useEffect(() => {
    const sync = () => setKey(readAdminKey());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return key;
}
