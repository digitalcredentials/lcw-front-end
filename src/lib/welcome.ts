// The welcome-credential flow: a newly registered account is offered a
// welcome credential (the LCW Sandbox Badge from the test issuer) the first
// time the wallet opens. Registration marks the offer pending for the email;
// the signed-in shell shows the flow once and clears the mark.

const PENDING_KEY = 'lcw_welcome_pending';

export function markWelcomePending(email: string): void {
  localStorage.setItem(PENDING_KEY, email);
}

// Pending only for the email that registered here, so signing into another
// account on this browser is not offered someone else's welcome credential.
export function isWelcomePending(email: string | null): boolean {
  return Boolean(email) && localStorage.getItem(PENDING_KEY) === email;
}

export function clearWelcomePending(): void {
  localStorage.removeItem(PENDING_KEY);
}

// Asks the test issuer to email the claim link for the welcome credential:
// the same notification the issuer's own form sends, carrying the name that
// ends up on the credential.
export async function requestWelcomeCredential(name: string, email: string): Promise<void> {
  const base = (import.meta.env.VITE_ISSUER_API_BASE ?? '').replace(/\/+$/, '');
  const response = await fetch(`${base}/workflows/lcw-sandbox-badge/notifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'The welcome credential email could not be sent.');
  }
}
