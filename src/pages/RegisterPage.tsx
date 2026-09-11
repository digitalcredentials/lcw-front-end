import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { register } from '../lib/register';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      // Registration finishes by email: the back end starts the registration
      // flow, which sends a confirmation link.
      setNotice(await register(email, password, registrationCode));
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
          <h1 className="text-2xl font-bold text-gray-900">Learner Credential Wallet</h1>
          <p className="mt-3 text-xs font-semibold tracking-wide text-amber-700">
            THIS IS A SANDBOX FOR TESTING AND WILL BE RESET FREQUENTLY
          </p>
          <p className="mt-1 text-xs font-semibold tracking-wide text-amber-700">
            DO NOT STORE ANYTHING YOU&#39;D LIKE TO KEEP
          </p>
        </header>
        <div className="w-full bg-white rounded-2xl shadow-md p-8">
        <h2 className="text-2xl font-semibold text-gray-800 mb-1">Create account</h2>
        <p className="text-sm text-gray-500 mb-6">Register to access your files</p>

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
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
              Confirm password
            </label>
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label htmlFor="registrationCode" className="block text-sm font-medium text-gray-700 mb-1">
              Registration Code
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

          {notice && (
            <p role="status" className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
              {notice}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-4 py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            {loading ? 'Registering…' : 'Create account'}
          </button>
        </form>

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
