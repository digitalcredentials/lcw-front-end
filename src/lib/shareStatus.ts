// The share dialog's status line: one sentence about the most serious problem
// the pre-share check found, with the detail behind a "Why?" toggle. It is
// information, never a verdict, and never blocks sharing.
//
// The issuer and expiry wording is the share dialog's own (issue #153). The
// other failures borrow the verifier plugin's headlines word for word, so the
// wallet does not grow a third way of saying the same thing; issue #133 will
// give both places one source.
import type { ShareVerification } from './verify';

export interface ShareStatus {
  // The status line itself
  line: string;
  // Under "Why?": one entry per problem, when there is more than one
  list: string[];
  // Under "Why?", after any list
  detail: string;
}

interface Problem {
  headline: string;
  // Why it happened, without the signature or "you can still share it"
  // sentences, which depend on what else was found
  explanation: string;
}

// Most serious first. A check id not listed here ranks with revocation.
const SEVERITY = ['fatal', 'could_not_run', 'valid_signature', 'revocation_status', 'expiration', 'registered_issuer'];

function rank(id: string): number {
  const index = SEVERITY.indexOf(id);
  return index === -1 ? SEVERITY.indexOf('revocation_status') : index;
}

const STILL_SHARE = 'You can still share it.';
const ISSUER_LIST = 'Only a small share of issuers are on the list so far, so this is common.';
const SIGNATURE_UNCHANGED = "The signature is valid, so the information hasn't changed since it was issued.";
const END_DATE = 'The issuer set an end date and it has passed.';

function problemFor(id: string, issuer: string | null, expired: string | null): Problem {
  switch (id) {
    case 'registered_issuer':
      return { headline: `${issuer ?? 'The issuer'} isn't on our list of known issuers`, explanation: ISSUER_LIST };
    case 'expiration':
      return {
        headline: expired ? `This credential expired on ${expired}` : 'This credential has expired',
        explanation: END_DATE,
      };
    case 'valid_signature':
      return { headline: 'This credential has been tampered with', explanation: '' };
    case 'revocation_status':
      return { headline: 'The issuer has deactivated this copy', explanation: '' };
    case 'could_not_run':
      return { headline: "We couldn't check this right now", explanation: '' };
    default:
      return { headline: "We can't check this credential", explanation: '' };
  }
}

// The status line for a failed check, or null when every check passed.
// `issuer` is the issuer's display name, `expired` the formatted expiry date;
// either may be null when the credential does not give one.
export function shareStatus(
  verification: ShareVerification,
  { issuer, expired }: { issuer: string | null; expired: string | null }
): ShareStatus | null {
  if (verification.ok) {
    return null;
  }
  const ids = [...new Set(verification.failed)].sort((a, b) => rank(a) - rank(b));
  const problems: Problem[] = [];
  for (const id of ids.length ? ids : ['fatal']) {
    const problem = problemFor(id, issuer, expired);
    if (!problems.some((p) => p.headline === problem.headline)) {
      problems.push(problem);
    }
  }
  const [lead] = problems;
  const line = `${lead.headline}. Some people may not accept it.`;
  const signature = verification.signatureValid;

  if (problems.length === 1) {
    const id = ids[0];
    if (id === 'registered_issuer') {
      return { line, list: [], detail: [ISSUER_LIST, signature && SIGNATURE_UNCHANGED, STILL_SHARE].filter(Boolean).join(' ') };
    }
    if (id === 'expiration') {
      return {
        line,
        list: [],
        detail: `${END_DATE} ${signature ? 'The signature is valid, and you can still share it.' : STILL_SHARE}`,
      };
    }
    return { line, list: [], detail: STILL_SHARE };
  }

  return {
    line,
    list: problems.map((p) => [`${p.headline}.`, p.explanation].filter(Boolean).join(' ')),
    detail: signature ? `${SIGNATURE_UNCHANGED} ${STILL_SHARE}` : STILL_SHARE,
  };
}
