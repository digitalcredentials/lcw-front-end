import { useState, type FormEvent } from 'react';
import Brand from '../components/Brand';
import PasswordInput from '../components/PasswordInput';
import { Link } from 'react-router-dom';
import { registerAccount } from '../lib/identity';
import { identityConfig } from '../lib/identity/config';
import { markWelcomePending } from '../lib/welcome';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');
  const [error, setError] = useState('');
  // Set once the back end has started the registration: the form gives way
  // to a "Check your email" state, so a second click cannot register again
  const [submitted, setSubmitted] = useState<{ message: string; email: string } | null>(null);
  const [loading, setLoading] = useState(false);
  // Registration mints the account's keys, creates its space and publishes
  // its identity, so it takes a few seconds; the stage names what is happening
  const [stage, setStage] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      // Registration finishes by email: the back end starts the registration
      // flow, which sends a confirmation link.
      const message = await registerAccount({
        email,
        passphrase: password,
        registrationCode,
        config: identityConfig(),
        onStage: setStage,
      });
      setSubmitted({ message, email });
      // The first signed-in open on this browser offers the welcome credential.
      // Best effort: the registration has gone through, so blocked storage
      // must not bring the form (and a second registration) back.
      try {
        markWelcomePending(email);
      } catch (err) {
        console.error('Could not remember the welcome offer:', err);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to register. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <header className="text-center mb-6">
          <Brand centered />
          <p className="mt-3 text-xs font-semibold tracking-wide text-amber-700">
            THIS IS A SANDBOX FOR TESTING AND WILL BE RESET FREQUENTLY
          </p>
          <p className="mt-1 text-xs font-semibold tracking-wide text-amber-700">
            DO NOT STORE ANYTHING YOU&#39;D LIKE TO KEEP
          </p>
        </header>
        <div className="w-full bg-white rounded-2xl shadow-md p-8">
        {submitted ? (
          <div role="status">
            <h2 className="text-2xl font-semibold text-gray-800 mb-4">Check your email</h2>
            <p className="text-sm text-gray-700">{submitted.message}</p>
            <p className="mt-2 text-sm text-gray-700">
              Sent to <span className="font-medium">{submitted.email}</span>.
            </p>
          </div>
        ) : (
        <>
        <h2 className="text-2xl font-semibold text-gray-800 mb-6">Create account</h2>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <PasswordInput id="password" autoComplete="new-password" value={password} onChange={setPassword} />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm password
            </label>
            <PasswordInput id="confirmPassword" autoComplete="new-password" value={confirmPassword} onChange={setConfirmPassword} />
          </div>

          <div>
            <label htmlFor="registrationCode" className="block text-sm font-medium text-gray-700 mb-1">
              Registration code
            </label>
            <input
              id="registrationCode"
              type="text"
              autoComplete="off"
              required
              value={registrationCode}
              onChange={(e) => setRegistrationCode(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="Your registration code"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            {loading ? `${stage || 'Creating account'}…` : 'Create account'}
          </button>
        </form>
        </>
        )}

        <p className="mt-5 text-sm text-gray-500 text-center">
          Already have an account?{' '}
          <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium">
            Sign in
          </Link>
        </p>
        </div>
      </div>
    </div>
  );
}
