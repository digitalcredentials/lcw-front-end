// The deployment's welcome page: where a signed-out visitor who opens the
// wallet's plain address is sent (VITE_WELCOME_URL, one per deployment:
// https://welcome.alpha.lcw.app for alpha.lcw.app). Unset, the plain address
// opens the sign-in form as before.
//
// Only the plain address redirects. Every page of the wallet has a `#`
// address (#/login, #/register, #/forgot) that the server never sees, so a
// link to any of them keeps opening its page, and a path the hosting serves
// itself (lcw.app/request) is not the plain address either.

export function welcomePageUrl(): string | undefined {
  return (import.meta.env.VITE_WELCOME_URL ?? '').trim() || undefined
}

// The wallet's plain address: its root, with no `#` page and no query
export function isPlainAddress({ pathname, search, hash }: { pathname: string; search: string; hash: string }): boolean {
  return (pathname === '/' || pathname === '/index.html') && search === '' && (hash === '' || hash === '#/')
}
