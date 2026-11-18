import { useEffect, useState, type FormEvent } from 'react';
import AppShell from '../components/AppShell';
import LoadingLabel from '../components/LoadingLabel';
import { getSession } from '../lib/identity';
import { identityConfig } from '../lib/identity/config';
import { readContactChoice, saveContactChoice, type ContactChoice } from '../lib/contactChoice';

// Settings → Email updates: the tester's answer to "Contact me with news and
// updates", asked on the register page and kept by the back end with the
// account, shown and changed here.

function changedOn(iso: string | undefined): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function EmailUpdatesPage() {
  const [saved, setSaved] = useState<ContactChoice | null>(null);
  const [checked, setChecked] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const email = getSession()?.email ?? '';

  useEffect(() => {
    const session = getSession();
    if (!session) {
      return;
    }
    let cancelled = false;
    readContactChoice({ session, apiBase: identityConfig().apiBase })
      .then((choice) => {
        if (!cancelled) {
          setSaved(choice);
          setChecked(choice.contactOptIn);
        }
      })
      .catch((err) => {
        console.error('Wallet: the contact choice could not be read:', err);
        if (!cancelled) {
          setLoadError('Your choice could not be loaded. Try again later.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const session = getSession();
    if (!session) {
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const choice = await saveContactChoice({ session, apiBase: identityConfig().apiBase, contactOptIn: checked });
      setSaved(choice);
      setChecked(choice.contactOptIn);
      setNotice(choice.contactOptIn ? 'Saved. We may contact you with news and updates.' : 'Saved. We will not contact you with news and updates.');
    } catch (err) {
      console.error('Wallet: the contact choice could not be saved:', err);
      setError('Your choice could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const lastChanged = changedOn(saved?.updatedAt);
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold text-gray-800 mb-1">Email updates</h1>
      <p className="text-sm text-gray-500 mb-6">
        Whether we may email you{email && <> at <span className="font-medium text-gray-700">{email}</span></>} with news
        and updates about the Learner Credential Wallet. You were asked when you registered.
      </p>

      {notice && (
        <p role="status" className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
          {notice}
        </p>
      )}
      {(loadError || error) && (
        <p role="alert" className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {loadError || error}
        </p>
      )}

      {saved === null ? (
        !loadError && (
          <p className="text-sm text-gray-500">
            <LoadingLabel label="Loading…" />
          </p>
        )
      ) : (
        <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-sm border border-gray-200 px-5 py-4 space-y-4 max-w-xl">
          <div className="flex items-start gap-2">
            <input
              id="contactOptIn"
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <label htmlFor="contactOptIn" className="text-sm text-gray-700">
              Contact me with news and updates
            </label>
          </div>
          {lastChanged && <p className="text-xs text-gray-500">Last changed {lastChanged}.</p>}
          <button
            type="submit"
            disabled={busy || checked === saved.contactOptIn}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-medium text-sm rounded-lg px-4 py-2 transition-colors"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}
    </AppShell>
  );
}
