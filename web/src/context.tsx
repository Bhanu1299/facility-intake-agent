import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Asset, AutonomyMode, Budget, Site, Vendor } from '@fia/shared';
import { api } from './api';

interface AppState {
  mode: AutonomyMode | null;
  modeError: string | null;
  setMode: (mode: AutonomyMode) => Promise<void>;
  sites: Site[];
  assets: Asset[];
  vendors: Vendor[];
  budgets: Budget[];
  catalogError: string | null;
  /** Re-fetch catalog data (budgets change on approval). */
  refreshCatalog: () => void;
  /** Bumped after a demo reset so every page reloads. */
  version: number;
  resetDemo: () => Promise<void>;
  siteName: (id: string) => string;
  vendorName: (id: string | null) => string;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AutonomyMode | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [catalogTick, setCatalogTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.sites(), api.assets(), api.vendors(), api.budgets()])
      .then(([s, a, v, b]) => {
        if (cancelled) return;
        setSites(s);
        setAssets(a);
        setVendors(v);
        setBudgets(b);
        setCatalogError(null);
      })
      .catch(
        (e: unknown) => !cancelled && setCatalogError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
    };
  }, [version, catalogTick]);

  useEffect(() => {
    api
      .autonomy()
      .then((r) => setModeState(r.mode))
      .catch((e: unknown) => setModeError(e instanceof Error ? e.message : String(e)));
  }, [version]);

  const setMode = useCallback(async (next: AutonomyMode) => {
    const r = await api.setAutonomy(next);
    setModeState(r.mode);
  }, []);

  const resetDemo = useCallback(async () => {
    await api.resetDemo();
    setVersion((v) => v + 1);
  }, []);

  const value = useMemo<AppState>(() => {
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const vendorById = new Map(vendors.map((v) => [v.id, v]));
    return {
      mode,
      modeError,
      setMode,
      sites,
      assets,
      vendors,
      budgets,
      catalogError,
      refreshCatalog: () => setCatalogTick((t) => t + 1),
      version,
      resetDemo,
      // Blank (not the raw id) until the catalog has loaded, so ids never flash on screen.
      siteName: (id) => siteById.get(id)?.shortName ?? (sites.length ? id : ''),
      vendorName: (id) =>
        id ? (vendorById.get(id)?.name ?? (vendors.length ? id : '')) : 'Unassigned',
    };
  }, [mode, modeError, setMode, sites, assets, vendors, budgets, catalogError, version, resetDemo]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
