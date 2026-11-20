import { IssuerError, PlainError, outsideText } from './errors';
import { getSession, sessionAgents } from './identity';
import { identityConfig } from './identity/config';
import { listResourceIds } from './credentials';
import { getSessionWASClient } from './was';
// The welcome-credential flow: an account is offered a welcome credential
// (the LCW Alpha Testing Badge from the test issuer) the first time the
// wallet opens after registration, and again at every sign-in for as long
// as the wallet holds no credential. Registration marks the first offer
// pending for the email; the signed-in shell shows the flow.
//
// The issuer gives the badge to wallet accounts, once each. The wallet asks
// its back end for the account's grant (a request signed as the account)
// and sends it to the issuer with the request for the emailed link.

const PENDING_KEY = 'lcw_welcome_pending';
// Set when the offer is declined or its email is sent, for this tab until
// the next sign-in
const DISMISSED_KEY = 'lcw_badge_offer_dismissed';

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

// The offer is not shown again in this tab until the next sign-in.
export function dismissBadgeOffer(): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, 'true');
  } catch {
    // Nothing to remember with; the offer shows again at the next open.
  }
}

export function isBadgeOfferDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

// A sign-in: the offer may be shown again.
export function resetBadgeOffer(): void {
  try {
    sessionStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Nothing was remembered.
  }
}

// Whether the wallet holds no credential at all, read from the account
// Space itself (a count of the stored credentials, nothing decrypted).
// False when it cannot be told, so a failed read offers nothing.
export async function walletHoldsNoCredential(): Promise<boolean> {
  try {
    const client = await getSessionWASClient();
    if (!client) {
      return false;
    }
    return (await listResourceIds(client.space)).length === 0;
  } catch {
    return false;
  }
}

// The account's grant for the badge, from the wallet's back end.
async function badgeGrant(email: string): Promise<string> {
  const session = getSession();
  if (!session) {
    throw new Error('UNAUTHORIZED');
  }
  const { zcapClient } = await sessionAgents(session);
  try {
    const response = await zcapClient.request({ url: `${identityConfig().apiBase}/badge-grant`, method: 'POST', action: 'write', json: { email } });
    const grant = (response.data as { grant?: unknown } | undefined)?.grant;
    if (typeof grant !== 'string' || !grant) {
      throw new Error('The back end answered without a grant.');
    }
    return grant;
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      throw new PlainError('This account has already collected its Alpha Testing Badge.');
    }
    throw err;
  }
}

// Asks the test issuer to email the claim link for the welcome credential,
// carrying the name that ends up on the credential and the account's grant.
export async function requestWelcomeCredential(name: string, email: string): Promise<void> {
  const grant = await badgeGrant(email);
  const base = (import.meta.env.VITE_ISSUER_API_BASE ?? '').replace(/\/+$/, '');
  const response = await fetch(`${base}/workflows/lcw-sandbox-badge/notifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, grant }),
  }).catch((err) => {
    throw new IssuerError('The issuer could not be reached.', undefined, err);
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new IssuerError(outsideText(body?.error) ?? 'The welcome credential email could not be sent.', response.status);
  }
}
