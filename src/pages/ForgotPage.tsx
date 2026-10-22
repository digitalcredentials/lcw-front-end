import { useState, type FormEvent } from 'react';
import Brand from '../components/Brand';
import PasswordInput from '../components/PasswordInput';
import { Link, useNavigate } from 'react-router-dom';
import { recoverAccount, requestRecoveryEmail, setSession, recoverySecretOf } from '../lib/identity';
import { identityConfig } from '../lib/identity/config';

// "Forgot your password?": two steps. The address asks the back end to email
// the account's recovery code; the code, with a new password, opens the
// account through its recovery credential and replaces the password.
export default function ForgotPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await requestRecoveryEmail({ email: email.trim(), config: identityConfig() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The recovery email could not be requested.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRecover(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!recoverySecretOf(code)) {
      setError('That does not look like a recovery code. Copy it from the email exactly as sent.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setStage('Opening your account');
    try {
      const session = await recoverAccount({
        email: email.trim(),
        code,
        newPassphrase: password,
        config: identityConfig(),
      });
      setSession(session);
      navigate('/files');
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 400 || status === 401
          ? 'That recovery code does not match this account, or it has already been used. Request a new one.'
          : 'Your account could not be recovered. Please try again.'
      );
      setBusy(false);
      setStage('');
    }
  }

  const input =
    'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent';
  const primary =
    'w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="text-center mb-6">
          <Brand centered />
        </header>
        <div className="w-full bg-white rounded-2xl shadow-md p-8">
          <h2 className="text-2xl font-semibold text-gray-800 mb-1">Recover your account</h2>
          {!sent ? (
            <form onSubmit={handleSend} className="space-y-4 mt-4" noValidate>
              <p className="text-sm text-gray-500">
                Enter the email address you registered with. We will email you a recovery code.
              </p>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} placeholder="you@example.com" />
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}
              <button type="submit" disabled={busy || !email.trim()} className={primary}>
                {busy ? 'Sending…' : 'Email me a recovery code'}
              </button>
              <button type="button" onClick={() => setSent(true)} className="w-full text-sm text-indigo-600 hover:text-indigo-700 font-medium">
                I already have a code
              </button>
            </form>
          ) : (
            <form onSubmit={handleRecover} className="space-y-4 mt-4" noValidate>
              <p role="status" className="text-sm text-gray-500">
                If that address has an account, a recovery code is on its way. Paste it here and choose a new password.
              </p>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
              </div>
              <div>
                <label htmlFor="code" className="block text-sm font-medium text-gray-700 mb-1">Recovery code</label>
                <input id="code" type="text" autoComplete="off" spellCheck={false} required value={code} onChange={(e) => setCode(e.target.value)} className={`${input} font-mono`} placeholder="XXXX-XXXX-XXXX-…" />
              </div>
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">New password</label>
                <PasswordInput id="new-password" autoComplete="new-password" value={password} onChange={setPassword} />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">Confirm new password</label>
                <PasswordInput id="confirm-password" autoComplete="new-password" value={confirmPassword} onChange={setConfirmPassword} />
              </div>
              {error && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
              )}
              <button type="submit" disabled={busy || !email.trim() || !code.trim() || !password} className={primary}>
                {busy ? `${stage || 'Recovering'}…` : 'Recover account'}
              </button>
              <button type="button" onClick={() => { setSent(false); setError(''); }} className="w-full text-sm text-indigo-600 hover:text-indigo-700 font-medium">
                Send another code
              </button>
            </form>
          )}
          <p className="mt-5 text-sm text-gray-500 text-center">
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
