import { useParams } from 'react-router-dom';

/** The page a QR code opens. Built out in Phase 6. */
export function RequestPage() {
  const { siteId } = useParams();
  return (
    <div className="flex min-h-screen justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Report a problem</h1>
        <p className="mt-2 text-slate-600">Site: {siteId}</p>
        <p className="mt-6 text-sm text-slate-500">Request form arrives in Phase 6.</p>
      </div>
    </div>
  );
}
