// The wallet's identity as a heading: the Digital Credentials Commons mark
// (public/dcc-commons-mark.png, copied from badge-assets) beside the
// organisation and product names. The same block the signed-in sidebar
// shows; here for the pages outside it (login, register, the CHAPI window).
export default function Brand({ centered = false }: { centered?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${centered ? 'justify-center text-left' : ''}`}>
      <img src="/dcc-commons-mark.png" alt="" className="h-12 w-12 shrink-0" />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-gray-600 leading-tight">
          Digital Credentials Commons
        </span>
        <h1 className="text-xl font-bold text-gray-900 leading-tight">Learner Credential Wallet</h1>
      </span>
    </div>
  );
}
