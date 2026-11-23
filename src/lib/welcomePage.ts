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

// The welcome site's full-page feedback form, which the wallet's Share
// feedback link opens (lcw-welcome serves it at /feedback, and records
// ?from=wallet as where the feedback was sent from). Undefined without a
// welcome page, so the wallet shows no link rather than a broken one.
export function feedbackPageUrl(welcomeUrl = welcomePageUrl()): string | undefined {
  if (!welcomeUrl) {
    return undefined
  }
  return `${welcomeUrl.replace(/\/+$/, '')}/feedback?from=wallet`
}

// The wallet's plain address: its root, with no `#` page and no query
export function isPlainAddress({ pathname, search, hash }: { pathname: string; search: string; hash: string }): boolean {
  return (pathname === '/' || pathname === '/index.html') && search === '' && (hash === '' || hash === '#/')
}
