const TOKEN_KEY = 'lcw_auth_token';
const SPACE_KEY = 'lcw_space_url';
const SESSION_KEY_KEY = 'lcw_session_key';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SPACE_KEY);
  localStorage.removeItem(SESSION_KEY_KEY);
}

// The exported key pair that authenticated at login, kept for signing WAS
// requests during the session.
export function getSessionKey(): object | null {
  const stored = localStorage.getItem(SESSION_KEY_KEY);
  return stored ? (JSON.parse(stored) as object) : null;
}

export function setSessionKey(exportedKeyPair: object): void {
  localStorage.setItem(SESSION_KEY_KEY, JSON.stringify(exportedKeyPair));
}

// The logged-in account's Wallet Attached Storage space URL, returned by the
// login API.
export function getSpaceUrl(): string | null {
  return localStorage.getItem(SPACE_KEY);
}

export function setSpaceUrl(spaceUrl: string): void {
  localStorage.setItem(SPACE_KEY, spaceUrl);
}

export function isAuthenticated(): boolean {
  return Boolean(getToken());
}
