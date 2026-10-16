import { useState } from 'react';

// A password field with a Show/Hide button. The page keeps its own <label>
// for the input. The button is named by its visible text alone, never with
// "password", so the field stays the only thing labelled "Password".
export default function PasswordInput({
  id,
  autoComplete,
  value,
  onChange,
}: {
  id: string;
  autoComplete: 'new-password' | 'current-password';
  value: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 pl-3 pr-16 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
      />
      <button
        type="button"
        aria-controls={id}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 px-3 text-sm font-medium text-indigo-600 hover:text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-r-lg"
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
