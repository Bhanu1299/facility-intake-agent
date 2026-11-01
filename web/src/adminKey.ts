import { useEffect, useState } from 'react';

const KEY = 'fia.callAdminKey';
const EVENT = 'fia:admin-key';

/** The call admin key stays in this browser (localStorage) until "Forget key". */
export function readAdminKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeAdminKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
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
    // Other tabs saving or forgetting the key.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return key;
}
