import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import QRCode from 'qrcode';
import {
  credentialFrom,
  credentialExpiration,
  credentialIssuance,
  issuerName,
  linkedinAddToProfileUrl,
  type CredentialLike,
} from '../lib/linkedin';
import { verifyForSharing, type ShareVerification } from '../lib/verify';
import { shareStatus } from '../lib/shareStatus';

interface ShareCredentialModalProps {
  resourceName: string;
  // The credential's current public URL, or null when it is not shared
  onFindPublicLink: () => Promise<string | null>;
  // Publishes the public copy and resolves to its URL; the same URL each time
  onCreatePublicLink: () => Promise<string>;
  // Takes the public copy down, so the link stops working until it is shared again
  onUnshare: () => Promise<void>;
  // Fetches the stored resource body (envelope or bare credential), for the
  // heading, the pre-share check and LinkedIn's add-to-profile form
  onLoadCredential: () => Promise<unknown>;
  onClose: () => void;
}

type Visibility = 'private' | 'public';
type SendAction = 'linkedin' | 'qr' | 'apps';
type Question =
  | { kind: 'takeDown' }
  | { kind: 'switch'; action: SendAction }
  | { kind: 'linkedinIssuer' };

const SWITCH_LEAD: Record<SendAction, string> = {
  linkedin: 'To add it to LinkedIn',
  qr: 'To show a QR code',
  apps: 'To send it with another app',
};

const LOOKUP_FAILED = 'Could not find out who can see it. Close this and try again.';

const NO_ISSUER =
  "This credential does not name its issuer, so LinkedIn's issuing organization field will be left blank.";

// Opens VerifierPlus on the public credential URL; the vc parameter is passed
// unencoded, matching how VerifierPlus reads it from the fragment
function verifierLinkFor(publicUrl: string): string {
  return `https://verifierplus.org/#verify?vc=${publicUrl}`;
}

// The one error the page's callbacks write for the learner
// (SpaceBrowserPage.tsx); every other error is the storage client's own text
const SESSION_EXPIRED = 'Your session has expired. Sign in again.';

// The plain message to show, with the raw error kept in the console for
// debugging. #158 will replace this with the wallet-wide error mapping.
function errorText(err: unknown, fallback: string): string {
  console.error(err);
  return err instanceof Error && err.message === SESSION_EXPIRED ? SESSION_EXPIRED : fallback;
}

const SECONDARY_BUTTON =
  'border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium text-sm rounded-lg px-3 py-1.5 transition-colors';

export default function ShareCredentialModal({
  resourceName, onFindPublicLink, onCreatePublicLink, onUnshare, onLoadCredential, onClose,
}: ShareCredentialModalProps) {
  const ids = useId();
  // null while the dialog finds out whether the credential is shared, and
  // when it could not find out
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  // The lookup failed. Nothing can be changed until the dialog is reopened:
  // assuming private would let a share publish a second link while the
  // first stays live and out of sight.
  const [lookupFailed, setLookupFailed] = useState(false);
  // The choice shown while a switch is under way; on failure it falls back
  // to `visibility`, which only changes once the switch has worked
  const [pending, setPending] = useState<Visibility | null>(null);
  const [publicLink, setPublicLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visMessage, setVisMessage] = useState('');
  const [visError, setVisError] = useState('');
  const [question, setQuestion] = useState<Question | null>(null);
  const [sendNotice, setSendNotice] = useState('');
  const [sendError, setSendError] = useState('');
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'direct' | null>(null);
  const [why, setWhy] = useState(false);
  // undefined while loading; null when the resource is not a credential
  const [credential, setCredential] = useState<CredentialLike | null | undefined>(undefined);
  // Pre-share verification (verifier-core); null when there is nothing to check
  const [verification, setVerification] = useState<'checking' | ShareVerification | null>('checking');

  const onlyYouRef = useRef<HTMLButtonElement>(null);
  const sendRefs = useRef<Record<SendAction, HTMLButtonElement | null>>({ linkedin: null, qr: null, apps: null });
  const safeButtonRef = useRef<HTMLButtonElement>(null);
  // Where focus returns once a question is answered, applied when the
  // buttons are enabled again
  const [focusAfter, setFocusAfter] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    onFindPublicLink()
      .then((url) => {
        if (!cancelled) {
          setPublicLink(url);
          setVisibility(url ? 'public' : 'private');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLookupFailed(true);
          setVisError(errorText(err, LOOKUP_FAILED));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load and verify the credential when the dialog opens. Non-credential
  // resources get no heading details and no status line.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = credentialFrom(await onLoadCredential());
        if (cancelled) {
          return;
        }
        setCredential(loaded);
        if (!loaded) {
          setVerification(null);
          return;
        }
        const result = await verifyForSharing(loaded);
        if (!cancelled) {
          setVerification(result);
        }
      } catch {
        // Could not load the body: nothing to verify, nothing to warn about
        if (!cancelled) {
          setCredential(null);
          setVerification(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (question) {
      safeButtonRef.current?.focus();
    }
  }, [question]);

  useEffect(() => {
    if (focusAfter && !busy) {
      focusAfter.focus();
      setFocusAfter(null);
    }
  }, [focusAfter, busy]);

  function clearMessages() {
    setVisMessage('');
    setVisError('');
    setSendNotice('');
    setSendError('');
  }

  async function makePublic(): Promise<string | null> {
    setBusy(true);
    setPending('public');
    try {
      const url = await onCreatePublicLink();
      setPublicLink(url);
      setVisibility('public');
      setVisMessage('Anyone with the link can now see it.');
      return url;
    } catch (err) {
      setVisError(errorText(err, 'Could not create the link.'));
      return null;
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function takeDown() {
    clearMessages();
    setQuestion(null);
    setBusy(true);
    setPending('private');
    try {
      await onUnshare();
      setVisibility('private');
      setPublicLink(null);
      setQrImage(null);
      setVisMessage('Link taken down. If you share it again, the same link will work again.');
    } catch (err) {
      setVisError(errorText(err, 'Could not take the link down.'));
      // Some copies may be down and others not: show what is actually live
      try {
        const url = await onFindPublicLink();
        setPublicLink(url);
        setVisibility(url ? 'public' : 'private');
        if (!url) {
          setQrImage(null);
        }
      } catch {
        setVisibility(null);
        setPublicLink(null);
        setQrImage(null);
        setLookupFailed(true);
      }
    } finally {
      setPending(null);
      setBusy(false);
      setFocusAfter(onlyYouRef.current);
    }
  }

  // Only you: while shared, asks before taking the link down
  function chooseOnlyYou() {
    clearMessages();
    setQuestion(visibility === 'public' ? { kind: 'takeDown' } : null);
  }

  // Anyone with the link: makes a private credential public straight away
  async function chooseAnyone() {
    clearMessages();
    setQuestion(null);
    if (visibility === 'private') {
      await makePublic();
    }
  }

  function openLinkedin(url: string, tab: Window | null) {
    if (!credential) {
      return;
    }
    const href = linkedinAddToProfileUrl({ credential, certUrl: verifierLinkFor(url) });
    if (tab) {
      tab.location.href = href;
    } else {
      window.open(href, '_blank', 'noopener');
    }
  }

  // `afterSwitch`: the credential was made public first, in the same click
  async function runSend(action: 'qr' | 'apps', url: string, afterSwitch: boolean) {
    if (action === 'qr') {
      try {
        setQrImage(await QRCode.toDataURL(verifierLinkFor(url), { width: 240, margin: 1 }));
      } catch (err) {
        setSendError(errorText(err, 'Could not create the QR code.'));
      }
      return;
    }
    try {
      await navigator.share({ title: resourceName, url: verifierLinkFor(url) });
    } catch (err) {
      // The share sheet opens only straight after a click, and making the
      // link may have taken too long. A dismissed share sheet needs nothing.
      if (afterSwitch && err instanceof DOMException && err.name === 'NotAllowedError') {
        setSendNotice("It's ready to send. Click Other apps again.");
      }
    }
  }

  async function send(action: SendAction) {
    clearMessages();
    if (action === 'qr' && qrImage) {
      setQrImage(null);
      setQuestion(null);
      return;
    }
    if (action === 'linkedin' && !credential) {
      setQuestion(null);
      setSendError('This resource does not look like a verifiable credential.');
      return;
    }
    if (visibility !== 'public' || !publicLink) {
      setQuestion({ kind: 'switch', action });
      return;
    }
    if (action === 'linkedin') {
      if (!issuerName(credential as CredentialLike)) {
        setQuestion({ kind: 'linkedinIssuer' });
        return;
      }
      setQuestion(null);
      openLinkedin(publicLink, null);
      return;
    }
    setQuestion(null);
    await runSend(action, publicLink, false);
  }

  async function confirmSwitch() {
    if (question?.kind !== 'switch') {
      return;
    }
    const { action } = question;
    const opener = sendRefs.current[action];
    // LinkedIn's tab is opened in the click itself and pointed at the form
    // once the link exists: a tab opened after waiting on the network can be
    // blocked as a popup
    let tab: Window | null = null;
    if (action === 'linkedin') {
      tab = window.open('', '_blank');
      if (tab) {
        tab.opener = null;
      }
    }
    clearMessages();
    setQuestion(null);
    const url = await makePublic();
    if (!url) {
      tab?.close();
    } else if (action === 'linkedin') {
      openLinkedin(url, tab);
    } else {
      await runSend(action, url, true);
    }
    setFocusAfter(opener);
  }

  function continueToLinkedin() {
    setQuestion(null);
    if (publicLink) {
      openLinkedin(publicLink, null);
    }
    setFocusAfter(sendRefs.current.linkedin);
  }

  function dismissQuestion() {
    const returnTo = question?.kind === 'takeDown'
      ? onlyYouRef.current
      : question?.kind === 'switch'
        ? sendRefs.current[question.action]
        : sendRefs.current.linkedin;
    setQuestion(null);
    setFocusAfter(returnTo);
  }

  async function copy(which: 'link' | 'direct') {
    if (!publicLink) {
      return;
    }
    try {
      await navigator.clipboard.writeText(which === 'link' ? verifierLinkFor(publicLink) : publicLink);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard unavailable; the link is selectable in the field
    }
  }

  // The device share sheet (email, message, AirDrop, ...) exists only where
  // the Web Share API does
  const canDeviceShare = typeof navigator.share === 'function';

  const shown = pending ?? visibility;
  const checking = visibility === null && !lookupFailed;
  // Nothing can change who can see it until the dialog knows
  const unknown = visibility === null;
  const isPublic = visibility === 'public' && publicLink !== null;

  const issuer = credential ? issuerName(credential) : null;
  const issued = credential ? credentialIssuance(credential) : null;
  const subtitle = [issuer, issued && `Issued ${issued.toLocaleDateString()}`].filter(Boolean).join(' · ');
  const status = credential && verification && verification !== 'checking'
    ? shareStatus(verification, {
      issuer,
      expired: credentialExpiration(credential)?.toLocaleDateString() ?? null,
    })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-labelledby={`${ids}-label ${ids}-title`}
        className="w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto bg-white rounded-2xl shadow-xl p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={`${ids}-label`} className="text-xs font-medium uppercase tracking-wide text-gray-500">Share</p>
            <h2 id={`${ids}-title`} className="text-lg font-semibold text-gray-800 break-words">{resourceName}</h2>
            {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-8 h-8 rounded-md text-xl leading-none text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {/* Announced when the check finishes, since the dialog is already
            open by then */}
        <div aria-live="polite">
          {verification === 'checking' && (
            <p className="text-xs text-gray-400 px-3 py-2">Checking this credential…</p>
          )}
          {status && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 space-y-1.5">
              <p>
                {status.line}{' '}
                <button
                  onClick={() => setWhy(!why)}
                  aria-expanded={why}
                  aria-controls={`${ids}-why`}
                  className="font-semibold underline underline-offset-2"
                >
                  {why ? 'Hide' : 'Why?'}
                </button>
              </p>
              {why && (
                <div id={`${ids}-why`} className="text-gray-700 space-y-1.5">
                  {status.list.length > 0 && (
                    <ul className="list-disc pl-4 space-y-1">
                      {status.list.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  )}
                  <p>{status.detail}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Two toggle buttons, not radios: a radio group changes selection
            on the arrow keys, which would share the credential or open the
            take-down question just by moving focus */}
        <div role="group" aria-labelledby={`${ids}-who`} aria-busy={checking || busy} className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 id={`${ids}-who`} className="text-sm font-semibold text-gray-800">Who can see it</h3>
            {checking && <span className="text-xs text-gray-400">Checking…</span>}
          </div>
          <VisibilityOption
            ref={onlyYouRef}
            id={`${ids}-only-you`}
            label="Only you"
            description="Nobody else can open it."
            pressed={shown === 'private'}
            target={question?.kind === 'takeDown'}
            disabled={unknown || busy}
            onClick={chooseOnlyYou}
          />
          <VisibilityOption
            id={`${ids}-anyone`}
            label="Anyone with the link"
            description="They see the credential and the result of checking it."
            pressed={shown === 'public'}
            target={question?.kind === 'switch'}
            disabled={unknown || busy}
            onClick={chooseAnyone}
          />
        </div>

        <p
          role="status"
          className={visMessage ? 'text-sm font-medium text-green-800 bg-green-50 rounded-lg px-3 py-2' : 'sr-only'}
        >
          {visMessage}
        </p>
        {visError && (
          <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {visError}
          </p>
        )}

        {question?.kind === 'takeDown' && (
          <div
            role="group"
            aria-labelledby={`${ids}-take-down`}
            className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2"
          >
            <p id={`${ids}-take-down`} className="text-sm text-gray-800">
              Switch to <b>Only you</b> and take the link down?
            </p>
            <p className="text-xs text-gray-600">
              Anyone you've already sent it to won't be able to open it,
              including from LinkedIn or a QR code. The direct link stops
              working too.
            </p>
            <div className="flex justify-end gap-2">
              <button ref={safeButtonRef} onClick={dismissQuestion} disabled={busy} className={SECONDARY_BUTTON}>
                Keep the link
              </button>
              <button
                onClick={takeDown}
                disabled={busy}
                className="bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white font-medium text-sm rounded-lg px-3 py-1.5 transition-colors"
              >
                Take it down
              </button>
            </div>
          </div>
        )}

        {isPublic && (
          <div className="flex gap-2">
            <input
              readOnly
              aria-label="Link to share"
              value={verifierLinkFor(publicLink)}
              onFocus={(e) => e.target.select()}
              className="flex-1 min-w-0 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 bg-gray-50"
            />
            <button
              onClick={() => copy('link')}
              className="shrink-0 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-xs rounded-md px-3 transition-colors"
            >
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-800">Send it</h3>
          {visibility === 'private' && (
            <p className="text-xs text-gray-500">
              Sending switches it to <b className="text-gray-700">Anyone with the link</b>. We'll ask first.
            </p>
          )}
          <div className={`grid gap-2 ${canDeviceShare ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <SendButton
              ref={(el) => { sendRefs.current.linkedin = el; }}
              onClick={() => send('linkedin')}
              disabled={unknown || busy || credential === undefined}
              icon={LINKEDIN_ICON}
              label="LinkedIn"
            />
            <SendButton
              ref={(el) => { sendRefs.current.qr = el; }}
              onClick={() => send('qr')}
              disabled={unknown || busy}
              pressed={qrImage !== null}
              icon={QR_ICON}
              label={qrImage ? 'Hide QR' : 'QR code'}
            />
            {canDeviceShare && (
              <SendButton
                ref={(el) => { sendRefs.current.apps = el; }}
                onClick={() => send('apps')}
                disabled={unknown || busy}
                icon={APPS_ICON}
                label="Other apps"
              />
            )}
          </div>
          {sendNotice && (
            <p role="status" className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              {sendNotice}
            </p>
          )}
          {sendError && (
            <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {sendError}
            </p>
          )}
        </div>

        {question?.kind === 'switch' && (
          <div
            role="group"
            aria-labelledby={`${ids}-switch`}
            className="bg-indigo-50 border border-indigo-100 rounded-lg p-3 space-y-2"
          >
            <p id={`${ids}-switch`} className="text-sm text-gray-800">
              {SWITCH_LEAD[question.action]}, switch to <b>Anyone with the link</b>?
            </p>
            <p className="text-xs text-gray-600">
              Anyone you give the link to will be able to see this credential.
            </p>
            {question.action === 'linkedin' && credential && !issuerName(credential) && (
              <p className="text-xs text-gray-600">{NO_ISSUER}</p>
            )}
            <div className="flex justify-end gap-2">
              <button ref={safeButtonRef} onClick={dismissQuestion} disabled={busy} className={SECONDARY_BUTTON}>
                Cancel
              </button>
              <button
                onClick={confirmSwitch}
                disabled={busy}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium text-sm rounded-lg px-3 py-1.5 transition-colors"
              >
                Switch and continue
              </button>
            </div>
          </div>
        )}

        {question?.kind === 'linkedinIssuer' && (
          <div
            role="group"
            aria-labelledby={`${ids}-issuer`}
            className="bg-indigo-50 border border-indigo-100 rounded-lg p-3 space-y-2"
          >
            <p id={`${ids}-issuer`} className="text-sm text-gray-800">{NO_ISSUER}</p>
            <div className="flex justify-end gap-2">
              <button ref={safeButtonRef} onClick={dismissQuestion} className={SECONDARY_BUTTON}>
                Cancel
              </button>
              <button
                onClick={continueToLinkedin}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg px-3 py-1.5 transition-colors"
              >
                Continue to LinkedIn
              </button>
            </div>
          </div>
        )}

        {qrImage && isPublic && (
          <div className="border border-gray-200 rounded-lg p-3 space-y-2">
            <img src={qrImage} alt="QR code for the link" className="mx-auto w-48 h-48" />
            <p className="text-xs text-gray-500 text-center">
              Opens the same page as the link. The link stays on until you take it down.
            </p>
          </div>
        )}

        {isPublic && (
          <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-3">
            <span id={`${ids}-direct`} className="text-xs text-gray-500">Direct link to the credential file</span>
            <button
              onClick={() => copy('direct')}
              aria-describedby={`${ids}-direct`}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-md px-2 py-1 transition-colors"
            >
              {copied === 'direct' ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function VisibilityOption({
  ref, id, label, description, pressed, target, disabled, onClick,
}: {
  ref?: Ref<HTMLButtonElement>;
  id: string;
  label: string;
  description: string;
  pressed: boolean;
  // Outlined while a question asks whether to switch to this option
  target: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-describedby={`${id}-description`}
      className={`w-full text-left grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 items-start rounded-lg border px-3 py-2.5 transition-colors disabled:opacity-60 ${
        pressed ? 'border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600' : 'border-gray-200 bg-white hover:border-gray-300'
      } ${target ? 'outline-2 outline-dashed outline-offset-2 outline-indigo-500' : ''}`}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 h-4 w-4 rounded-full border-2 grid place-items-center ${pressed ? 'border-indigo-600' : 'border-gray-400'}`}
      >
        {pressed && <span className="h-2 w-2 rounded-full bg-indigo-600" />}
      </span>
      <span className="text-sm font-medium text-gray-800">{label}</span>
      <span id={`${id}-description`} className="col-start-2 text-xs text-gray-500">{description}</span>
    </button>
  );
}

function SendButton({
  ref, onClick, disabled, pressed, icon, label,
}: {
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
  disabled: boolean;
  pressed?: boolean;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className="flex flex-col items-center gap-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60 px-2 py-2.5 text-xs font-medium text-gray-700 transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}

const LINKEDIN_ICON = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="w-5 h-5">
    <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9.75h4v11H3v-11Zm7 0h3.8v1.6h.06c.53-1 1.84-2 3.79-2 4.05 0 4.8 2.6 4.8 6v5.4h-4v-4.8c0-1.15-.02-2.63-1.6-2.63-1.6 0-1.85 1.25-1.85 2.55v4.88h-4v-11Z" />
  </svg>
);

const QR_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="w-5 h-5">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
  </svg>
);

const APPS_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="w-5 h-5">
    <path d="M12 3v12M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </svg>
);
