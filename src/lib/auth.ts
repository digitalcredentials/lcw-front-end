const TOKEN_KEY = 'lcw_auth_token';
const SPACE_KEY = 'lcw_space_url';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SPACE_KEY);
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
