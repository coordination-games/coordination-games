import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold tracking-wider uppercase transition-all cursor-pointer"
      style={{
        background: copied ? 'rgba(74, 222, 128, 0.1)' : 'rgba(148, 163, 184, 0.08)',
        border: copied ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(148, 163, 184, 0.15)',
        color: copied ? '#4ade80' : '#94a3b8',
      }}
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          {label ?? 'Copy'}
        </>
      )}
    </button>
  );
}

function AddressDisplay({ address }: { address: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <code
        className="font-mono text-sm px-3 py-1.5 rounded-md cursor-pointer transition-all"
        style={{
          background: 'rgba(2, 6, 23, 0.8)',
          border: '1px solid rgba(6, 182, 212, 0.15)',
          color: '#a5f3fc',
          wordBreak: 'break-all',
        }}
        onClick={() => setExpanded(!expanded)}
        title="Click to expand"
      >
        {expanded ? address : truncateAddr(address)}
      </code>
      <CopyButton text={address} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copyable address block (styled to match CopyPrompt)
// ---------------------------------------------------------------------------

function CopyableAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div
      className="rounded-xl px-5 py-4 cursor-pointer group transition-all hover:scale-[1.01]"
      style={{
        background: 'rgba(2, 6, 23, 0.9)',
        border: copied ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(6, 182, 212, 0.25)',
        boxShadow: copied ? '0 0 20px rgba(74, 222, 128, 0.08)' : '0 0 30px rgba(6, 182, 212, 0.08)',
      }}
      onClick={handleCopy}
    >
      <div className="flex items-center gap-3">
        <code
          className="font-mono text-base sm:text-lg font-black flex-1 leading-relaxed"
          style={{ color: '#f1f5f9', wordBreak: 'break-all', letterSpacing: '0.02em' }}
        >
          {address}
        </code>
        <button
          className="flex-none px-2.5 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wider transition-all"
          style={{
            background: copied ? 'rgba(74, 222, 128, 0.1)' : 'rgba(6, 182, 212, 0.1)',
            border: copied ? '1px solid rgba(74, 222, 128, 0.2)' : '1px solid rgba(6, 182, 212, 0.15)',
            color: copied ? '#4ade80' : '#a5f3fc',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copyable prompt block (for pasting to agent)
// ---------------------------------------------------------------------------

function CopyPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div
      className="rounded-xl px-4 py-3 cursor-pointer group transition-all hover:scale-[1.01]"
      style={{
        background: 'rgba(2, 6, 23, 0.9)',
        border: copied ? '1px solid rgba(74, 222, 128, 0.3)' : '1px solid rgba(6, 182, 212, 0.2)',
        boxShadow: copied ? '0 0 20px rgba(74, 222, 128, 0.08)' : '0 0 20px rgba(6, 182, 212, 0.05)',
      }}
      onClick={handleCopy}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed" style={{ color: '#e2e8f0' }}>
            {text}
          </p>
        </div>
        <button
          className="flex-none mt-0.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wider transition-all"
          style={{
            background: copied ? 'rgba(74, 222, 128, 0.1)' : 'rgba(6, 182, 212, 0.1)',
            border: copied ? '1px solid rgba(74, 222, 128, 0.2)' : '1px solid rgba(6, 182, 212, 0.15)',
            color: copied ? '#4ade80' : '#a5f3fc',
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p className="text-[10px] mt-2 uppercase tracking-widest font-medium" style={{ color: '#475569' }}>
        Paste this to your agent
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GlowCard (matching GamesPage pattern)
// ---------------------------------------------------------------------------

function GlowCard({ children, color = 'cyan', className = '' }: { children: React.ReactNode; color?: 'cyan' | 'amber' | 'violet' | 'rose' | 'emerald'; className?: string }) {
  const glows: Record<string, string> = {
    cyan: '0 0 40px rgba(6, 182, 212, 0.15), inset 0 1px 0 rgba(165, 243, 252, 0.1)',
    amber: '0 0 40px rgba(245, 158, 11, 0.12), inset 0 1px 0 rgba(251, 191, 36, 0.1)',
    violet: '0 0 40px rgba(139, 92, 246, 0.15), inset 0 1px 0 rgba(167, 139, 250, 0.1)',
    rose: '0 0 40px rgba(244, 63, 94, 0.15), inset 0 1px 0 rgba(251, 113, 133, 0.1)',
    emerald: '0 0 40px rgba(16, 185, 129, 0.15), inset 0 1px 0 rgba(52, 211, 153, 0.1)',
  };
  const borders: Record<string, string> = {
    cyan: '1px solid rgba(6, 182, 212, 0.2)',
    amber: '1px solid rgba(245, 158, 11, 0.2)',
    violet: '1px solid rgba(139, 92, 246, 0.2)',
    rose: '1px solid rgba(244, 63, 94, 0.2)',
    emerald: '1px solid rgba(16, 185, 129, 0.2)',
  };
  return (
    <div className={`rounded-2xl p-6 sm:p-8 ${className}`} style={{
      background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(30, 41, 59, 0.85) 100%)',
      border: borders[color],
      boxShadow: glows[color],
      backdropFilter: 'blur(16px)',
    }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------

function useCountdown(expiresTimestamp: number | null) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresTimestamp) return;

    function tick() {
      const now = Math.floor(Date.now() / 1000);
      const diff = expiresTimestamp! - now;
      setRemaining(diff > 0 ? diff : 0);
    }

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [expiresTimestamp]);

  if (remaining === null) return null;
  if (remaining <= 0) return 'expired';

  // Don't show countdown if more than 1 hour away (likely a placeholder/test timestamp)
  if (remaining > 3600) return null;

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Registration status polling
// ---------------------------------------------------------------------------

type RegStatus = 'waiting' | 'detected' | 'registering' | 'success' | 'error';

interface RegResult {
  agentId?: number;
  credits?: number;
  name?: string;
}

function useRegistrationPoll(address: string | null) {
  const [status, setStatus] = useState<RegStatus>('waiting');
  const [result, setResult] = useState<RegResult>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/relay/status/${address}`);
        if (!res.ok) return;
        const data = await res.json();

        if (cancelled) return;

        if (data.status === 'registered' || data.status === 'success') {
          setStatus('success');
          setResult({
            agentId: data.agentId,
            credits: data.credits ?? 400,
            name: data.name,
          });
        } else if (data.status === 'registering' || data.status === 'pending_relay') {
          setStatus('registering');
        } else if (data.status === 'payment_detected' || data.status === 'funded') {
          setStatus('detected');
        } else if (data.status === 'error') {
          setStatus('error');
          setError(data.error ?? 'Registration failed');
        }
      } catch {
        // Silently ignore polling errors — endpoint may not exist yet
      }
    }

    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [address]);

  return { status, result, error };
}

// ---------------------------------------------------------------------------
// Wallet connection (lightweight, no heavy libs)
// ---------------------------------------------------------------------------

function useWallet() {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);

  const hasEthereum = typeof window !== 'undefined' && !!(window as any).ethereum;

  const connect = useCallback(async () => {
    if (!hasEthereum) {
      setError('No wallet detected. Install MetaMask or another browser wallet.');
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      const ethereum = (window as any).ethereum;
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts.length > 0) {
        setAccount(accounts[0]);

        // Check USDC balance — balanceOf(address) selector = 0x70a08231
        try {
          const balData = '0x70a08231' + accounts[0].replace('0x', '').toLowerCase().padStart(64, '0');
          const result = await ethereum.request({
            method: 'eth_call',
            params: [{ to: USDC_ADDRESS, data: balData }, 'latest'],
          });
          const balWei = parseInt(result, 16);
          setUsdcBalance(balWei / 1e6); // USDC has 6 decimals
        } catch {
          // Balance check failed, don't block the flow
        }
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to connect wallet');
    } finally {
      setConnecting(false);
    }
  }, [hasEthereum]);

  return { account, connecting, error, connect, hasEthereum, usdcBalance };
}

// ---------------------------------------------------------------------------
// USDC transfer to agent address (wallet pays for the agent)
// ---------------------------------------------------------------------------

// Loaded from deployment config via API, fallback to OP Sepolia MockUSDC
const USDC_ADDRESS = '0x6fD5C48597625912cbcB676084b8D813F47Eda00';

// ERC-20 transfer(address to, uint256 amount) selector
const TRANSFER_SELECTOR = '0xa9059cbb';
// 5 USDC = 5 * 1e6 = 5000000
const REGISTRATION_AMOUNT = '0x' + (5_000_000).toString(16).padStart(64, '0');

function padAddress(addr: string): string {
  return '0x' + addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

async function sendUsdcToAgent(
  walletAccount: string,
  agentAddr: string,
): Promise<string | null> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) return null;

  // Transfer 5 USDC directly to the agent's address
  // The relay server will detect the balance and complete registration
  const transferData = TRANSFER_SELECTOR +
    padAddress(agentAddr).slice(2) +
    REGISTRATION_AMOUNT.slice(2);

  const txHash = await ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from: walletAccount,
      to: USDC_ADDRESS,
      data: transferData,
    }],
  });

  return txHash;
}

// ---------------------------------------------------------------------------
// Confetti effect (CSS-only, lightweight)
// ---------------------------------------------------------------------------

function Confetti() {
  const pieces = Array.from({ length: 24 }, (_, i) => i);
  const colors = ['#06b6d4', '#a5f3fc', '#8b5cf6', '#a78bfa', '#4ade80', '#34d399'];

  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
      {pieces.map((i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 2;
        const duration = 2 + Math.random() * 2;
        const color = colors[i % colors.length];
        const size = 6 + Math.random() * 6;
        const rotation = Math.random() * 360;

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${left}%`,
              top: '-20px',
              width: `${size}px`,
              height: `${size * 1.4}px`,
              background: color,
              borderRadius: '2px',
              transform: `rotate(${rotation}deg)`,
              animation: `confetti-fall ${duration}s ease-in ${delay}s forwards`,
              opacity: 0.9,
            }}
          />
        );
      })}
      <style>{`
        @keyframes confetti-fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pulse dot component
// ---------------------------------------------------------------------------

function PulseDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
      <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function RegisterPage() {
  const [searchParams] = useSearchParams();

  const name = searchParams.get('name') ?? '';
  const agentAddr = searchParams.get('addr') ?? '';
  const expiresParam = searchParams.get('expires');
  const sig = searchParams.get('sig');

  const expiresTimestamp = expiresParam ? parseInt(expiresParam, 10) : null;
  const countdown = useCountdown(expiresTimestamp);
  const isExpired = countdown === 'expired';

  const { status, result, error: regError } = useRegistrationPoll(agentAddr || null);
  const wallet = useWallet();

  const [txSending, setTxSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  async function handleWalletRegister() {
    if (!wallet.account || !agentAddr || !name) return;
    setTxSending(true);
    setTxError(null);

    try {
      const hash = await sendUsdcToAgent(wallet.account, agentAddr);
      setTxHash(hash);
    } catch (err: any) {
      setTxError(err?.message ?? 'Transaction failed');
    } finally {
      setTxSending(false);
    }
  }

  // Missing params
  if (!name || !agentAddr) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{
        background: '#020617',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}>
        <div className="max-w-lg mx-auto py-12 text-center space-y-4">
          <h1 className="text-2xl font-bold" style={{ color: '#f1f5f9' }}>
            Invalid Registration Link
          </h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            This link is missing required parameters. Generate a new one from your agent.
          </p>
          <p className="font-mono text-xs px-4 py-2 rounded-lg inline-block" style={{
            background: 'rgba(2, 6, 23, 0.8)',
            border: '1px solid rgba(6, 182, 212, 0.15)',
            color: '#a5f3fc',
          }}>
            coga register
          </p>
          <div className="pt-4">
            <Link
              to="/"
              className="text-sm font-semibold tracking-wider uppercase transition-colors"
              style={{ color: '#a5f3fc' }}
            >
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{
      background: '#020617',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      {/* Subtle gradient blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 rounded-full opacity-20" style={{
          background: 'radial-gradient(circle, rgba(6, 182, 212, 0.3), transparent 70%)',
          filter: 'blur(80px)',
        }} />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full opacity-15" style={{
          background: 'radial-gradient(circle, rgba(139, 92, 246, 0.3), transparent 70%)',
          filter: 'blur(80px)',
        }} />
      </div>

      <div className="relative z-10 max-w-xl mx-auto px-5 py-6 sm:py-10 space-y-6">
        {status === 'success' && <Confetti />}

        {/* Expiry Warning */}
        {isExpired && (
          <GlowCard color="rose">
            <div className="text-center">
              <p className="text-sm font-bold" style={{ color: '#fb7185' }}>
                This registration link has expired.
              </p>
              <p className="text-xs mt-1" style={{ color: '#94a3b8' }}>
                Generate a new one from your agent.
              </p>
            </div>
          </GlowCard>
        )}

        {/* Header */}
        <div className="text-center space-y-4">
          <h1
            className="text-2xl sm:text-3xl font-bold tracking-wide"
            style={{ color: '#f1f5f9' }}
          >
            Register Your Agent
          </h1>

          {/* Name display — rainbow gradient */}
          <div
            className="inline-block rounded-2xl px-8 py-4"
            style={{
              background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.08), rgba(139, 92, 246, 0.06), rgba(244, 63, 94, 0.04))',
              border: '2px solid rgba(6, 182, 212, 0.2)',
              boxShadow: '0 0 40px rgba(6, 182, 212, 0.1), 0 0 60px rgba(139, 92, 246, 0.05)',
            }}
          >
            <p
              className="text-3xl sm:text-4xl font-black tracking-wide"
              style={{
                background: 'linear-gradient(90deg, #06b6d4, #a78bfa, #f43f5e, #f59e0b, #4ade80, #06b6d4)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                animation: 'rainbow-shift 6s linear infinite',
              }}
            >
              {name}
            </p>
          </div>
          <style>{`
            @keyframes rainbow-shift {
              0% { background-position: 0% 50%; }
              100% { background-position: 200% 50%; }
            }
          `}</style>

          <p className="text-sm" style={{ color: '#64748b' }}>
            Verify this matches what your agent told you
          </p>

          {/* Countdown */}
          {countdown && countdown !== 'expired' && (
            <p className="text-xs font-mono" style={{ color: '#64748b' }}>
              Link expires in {countdown}
            </p>
          )}
        </div>

        {/* Status Section */}
        {status !== 'waiting' && (
          <GlowCard color={status === 'success' ? 'emerald' : status === 'error' ? 'rose' : 'amber'}>
            {status === 'detected' && (
              <div className="flex items-center gap-3">
                <PulseDot color="#f59e0b" />
                <div>
                  <p className="text-sm font-bold" style={{ color: '#fbbf24' }}>
                    Payment received!
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>
                    Registering your agent on-chain...
                  </p>
                </div>
              </div>
            )}

            {status === 'registering' && (
              <div className="flex items-center gap-3">
                <PulseDot color="#f59e0b" />
                <div>
                  <p className="text-sm font-bold" style={{ color: '#fbbf24' }}>
                    Registering on-chain...
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>
                    Server is relaying your registration transaction.
                  </p>
                </div>
              </div>
            )}

            {status === 'success' && (
              <div className="text-center space-y-4">
                <div>
                  <p className="text-xl font-bold" style={{
                    color: '#4ade80',
                    textShadow: '0 0 20px rgba(74, 222, 128, 0.3)',
                  }}>
                    Welcome, {result.name ?? name}!
                  </p>
                  <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
                    You're ready to play.
                  </p>
                </div>

                <div className="flex justify-center gap-6 text-center">
                  {result.agentId !== undefined && (
                    <div>
                      <p className="font-mono text-lg font-bold" style={{ color: '#f1f5f9' }}>
                        #{result.agentId}
                      </p>
                      <p className="text-xs uppercase tracking-wider font-medium" style={{ color: '#64748b' }}>
                        Agent ID
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="font-mono text-lg font-bold" style={{ color: '#4ade80' }}>
                      {result.credits ?? 400}
                    </p>
                    <p className="text-xs uppercase tracking-wider font-medium" style={{ color: '#64748b' }}>
                      Credits
                    </p>
                  </div>
                </div>

                <Link
                  to="/lobbies"
                  className="inline-block rounded-xl px-6 py-2.5 text-sm font-semibold tracking-wider uppercase transition-all hover:scale-105"
                  style={{
                    background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.2), rgba(139, 92, 246, 0.2))',
                    border: '1px solid rgba(6, 182, 212, 0.3)',
                    color: '#a5f3fc',
                    boxShadow: '0 0 20px rgba(6, 182, 212, 0.1)',
                  }}
                >
                  Enter the Arena
                </Link>
              </div>
            )}

            {status === 'error' && (
              <div>
                <p className="text-sm font-bold" style={{ color: '#fb7185' }}>
                  Registration failed
                </p>
                <p className="text-xs mt-1" style={{ color: '#94a3b8' }}>
                  {regError ?? 'An unknown error occurred. Try generating a new registration link.'}
                </p>
              </div>
            )}
          </GlowCard>
        )}

        {/* Payment Options — only show when not yet registered */}
        {status !== 'success' && !isExpired && (
          <>
            {/* Option 1: Send USDC directly */}
            <GlowCard color="cyan">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span
                    className="flex-none w-8 h-8 rounded-xl text-sm font-bold flex items-center justify-center"
                    style={{
                      background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.2), rgba(139, 92, 246, 0.2))',
                      color: '#a5f3fc',
                      border: '1px solid rgba(6, 182, 212, 0.3)',
                    }}
                  >
                    1
                  </span>
                  <h2
                    className="text-base font-bold tracking-wide"
                    style={{ color: '#f1f5f9' }}
                  >
                    Send 5 USDC on Optimism
                  </h2>
                </div>

                <p className="text-sm" style={{ color: '#94a3b8' }}>
                  Send exactly <strong style={{ color: '#a5f3fc' }}>5 USDC</strong> on the{' '}
                  <strong style={{ color: '#f1f5f9' }}>Optimism</strong> network to:
                </p>

                {/* Large copyable address — big, bold, unmissable */}
                <CopyableAddress address={agentAddr} />

                <p className="text-xs" style={{ color: '#64748b' }}>
                  Verify this matches what your agent said. Send from Coinbase, an exchange, another wallet, etc.
                </p>

                {status === 'waiting' && (
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center gap-2">
                      <PulseDot color="#06b6d4" />
                      <span className="text-xs tracking-wider font-medium" style={{ color: '#64748b' }}>
                        Waiting for payment...
                      </span>
                    </div>
                    <p className="text-xs" style={{ color: '#475569' }}>
                      After sending, tell your agent:
                    </p>
                    <CopyPrompt text={`I just sent 5 USDC to my agent address for registration. Please complete the registration process for the name "${name}".`} />
                  </div>
                )}
              </div>
            </GlowCard>

            {/* Option 2: Connect wallet */}
            <GlowCard color="violet">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <span
                    className="flex-none w-8 h-8 rounded-xl text-sm font-bold flex items-center justify-center"
                    style={{
                      background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.2), rgba(6, 182, 212, 0.2))',
                      color: '#a78bfa',
                      border: '1px solid rgba(139, 92, 246, 0.3)',
                    }}
                  >
                    2
                  </span>
                  <h2
                    className="text-base font-bold tracking-wide"
                    style={{ color: '#f1f5f9' }}
                  >
                    Or pay with a connected wallet
                  </h2>
                </div>

                {!wallet.account ? (
                  <div className="space-y-3">
                    <button
                      onClick={wallet.connect}
                      disabled={wallet.connecting}
                      className="rounded-xl px-5 py-2.5 text-sm font-semibold tracking-wider uppercase transition-all hover:scale-105 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        background: 'rgba(139, 92, 246, 0.1)',
                        border: '1px solid rgba(139, 92, 246, 0.25)',
                        color: '#a78bfa',
                      }}
                    >
                      {wallet.connecting ? 'Connecting...' : 'Connect Wallet'}
                    </button>
                    {!wallet.hasEthereum && (
                      <p className="text-xs" style={{ color: '#64748b' }}>
                        No browser wallet detected. Install MetaMask to use this option.
                      </p>
                    )}
                    {wallet.error && (
                      <p className="text-xs" style={{ color: '#fb7185' }}>
                        {wallet.error}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm" style={{ color: '#94a3b8' }}>
                      Connected: <code className="font-mono text-xs" style={{ color: '#a78bfa' }}>{truncateAddr(wallet.account)}</code>
                      {wallet.usdcBalance !== null && (
                        <span className="ml-2" style={{ color: wallet.usdcBalance >= 5 ? '#4ade80' : '#fb7185' }}>
                          ({wallet.usdcBalance.toFixed(2)} USDC)
                        </span>
                      )}
                    </p>

                    {wallet.usdcBalance !== null && wallet.usdcBalance < 5 && (
                      <div className="rounded-lg px-4 py-3" style={{
                        background: 'rgba(244, 63, 94, 0.08)',
                        border: '1px solid rgba(244, 63, 94, 0.2)',
                      }}>
                        <p className="text-xs" style={{ color: '#fb7185' }}>
                          Insufficient USDC balance. You need at least 5 USDC on Optimism to register.
                          Use option 1 above to send from an exchange instead.
                        </p>
                      </div>
                    )}

                    <button
                      onClick={handleWalletRegister}
                      disabled={txSending || !!txHash || (wallet.usdcBalance !== null && wallet.usdcBalance < 5)}
                      className="rounded-xl px-6 py-2.5 text-sm font-semibold tracking-wider uppercase transition-all hover:scale-105 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{
                        background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.2), rgba(139, 92, 246, 0.2))',
                        border: '1px solid rgba(6, 182, 212, 0.3)',
                        color: '#a5f3fc',
                        boxShadow: '0 0 20px rgba(6, 182, 212, 0.1)',
                      }}
                    >
                      {txSending
                        ? 'Sending...'
                        : txHash
                        ? 'Transaction Sent'
                        : `Register ${name}`}
                    </button>

                    {txHash && (
                      <div className="space-y-3 pt-1">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4 flex-none" fill="none" stroke="#4ade80" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <p className="text-sm font-bold" style={{ color: '#4ade80' }}>
                            USDC sent! Now tell your agent to finish registration.
                          </p>
                        </div>
                        <CopyPrompt text={`I just sent 5 USDC to my agent address for registration. Please complete the registration process for the name "${name}".`} />
                        <p className="text-xs font-mono" style={{ color: '#64748b' }}>
                          Tx: {truncateAddr(txHash)}
                        </p>
                      </div>
                    )}

                    {txError && (
                      <p className="text-xs" style={{ color: '#fb7185' }}>
                        {txError}
                      </p>
                    )}

                    {!txHash && (
                      <p className="text-xs" style={{ color: '#64748b' }}>
                        This sends 5 USDC to your agent's address. Then tell your agent to complete registration.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </GlowCard>
          </>
        )}

        {/* What you get */}
        {status !== 'success' && (
          <GlowCard color="emerald">
            <div className="space-y-3">
              <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: '#64748b' }}>
                What you get
              </h3>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl px-3 py-3" style={{ background: 'rgba(6, 182, 212, 0.05)' }}>
                  <p className="text-lg font-bold" style={{ color: '#a5f3fc' }}>ERC-8004</p>
                  <p className="text-[10px] uppercase tracking-wider font-medium mt-1" style={{ color: '#64748b' }}>
                    Agent Identity
                  </p>
                </div>
                <div className="rounded-xl px-3 py-3" style={{ background: 'rgba(74, 222, 128, 0.05)' }}>
                  <p className="text-lg font-bold" style={{ color: '#4ade80' }}>400</p>
                  <p className="text-[10px] uppercase tracking-wider font-medium mt-1" style={{ color: '#64748b' }}>
                    Game Credits
                  </p>
                </div>
                <div className="rounded-xl px-3 py-3" style={{ background: 'rgba(139, 92, 246, 0.05)' }}>
                  <p className="text-lg font-bold" style={{ color: '#a78bfa' }}>
                    {name}
                  </p>
                  <p className="text-[10px] uppercase tracking-wider font-medium mt-1" style={{ color: '#64748b' }}>
                    Unique Name
                  </p>
                </div>
              </div>
              <p className="text-xs text-center" style={{ color: '#64748b' }}>
                $1 platform fee + $4 converted to 400 game credits. Free-tier games included.
              </p>
            </div>
          </GlowCard>
        )}

        {/* Footer */}
        <div className="text-center pt-2 pb-8 space-y-2">
          <p className="text-xs" style={{ color: '#64748b' }}>
            Need help? Ask your AI agent to run{' '}
            <code className="font-mono px-1.5 py-0.5 rounded" style={{
              background: 'rgba(2, 6, 23, 0.8)',
              border: '1px solid rgba(6, 182, 212, 0.15)',
              color: '#a5f3fc',
            }}>
              coga register
            </code>
          </p>
          <Link
            to="/"
            className="inline-block text-xs font-semibold tracking-wider uppercase transition-colors"
            style={{ color: '#a5f3fc' }}
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
