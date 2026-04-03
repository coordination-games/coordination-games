/**
 * Challenge-response authentication for the coordination games framework.
 *
 * Auth flow:
 * 1. Client requests a challenge (nonce)
 * 2. Server issues a nonce with expiry
 * 3. Client signs the nonce with their private key (EIP-712)
 * 4. Server verifies signature, checks ERC-8004 registration
 * 5. Server issues a session token (opaque, time-limited)
 *
 * During the transition period (before on-chain identity is live),
 * the server supports a simplified auth flow where players register
 * with a handle and receive a token directly.
 */

import crypto from 'node:crypto';
import type { AuthChallenge, SessionToken } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface AuthConfig {
  challengeTtlMs?: number;
  sessionTtlMs?: number;
  /**
   * Optional function to verify an ERC-8004 registration.
   * If not provided, registration checks are skipped (dev mode).
   */
  verifyRegistration?: (address: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Auth manager
// ---------------------------------------------------------------------------

export class AuthManager {
  private challenges: Map<string, AuthChallenge> = new Map();
  private sessions: Map<string, SessionToken> = new Map();
  private playerSessions: Map<string, string> = new Map(); // playerId -> token
  private config: Required<Pick<AuthConfig, 'challengeTtlMs' | 'sessionTtlMs'>> & AuthConfig;

  constructor(config?: AuthConfig) {
    this.config = {
      challengeTtlMs: config?.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS,
      sessionTtlMs: config?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      ...config,
    };
  }

  /**
   * Issue a challenge nonce for a client to sign.
   */
  issueChallenge(): AuthChallenge {
    const nonce = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.config.challengeTtlMs;
    const message = `Sign this message to authenticate with Coordination Games.\nNonce: ${nonce}`;

    const challenge: AuthChallenge = { nonce, expiresAt, message };
    this.challenges.set(nonce, challenge);

    // Clean up expired challenges periodically
    this.cleanupChallenges();

    return challenge;
  }

  /**
   * Verify a signed challenge and issue a session token.
   *
   * @param nonce - The challenge nonce that was signed
   * @param signature - The EIP-712 signature
   * @param recoveredAddress - The address recovered from the signature
   *                           (caller is responsible for ecrecover)
   * @param playerId - The player's agentId
   */
  async verifyChallenge(
    nonce: string,
    signature: string,
    recoveredAddress: string,
    playerId: string,
  ): Promise<SessionToken | null> {
    // Check challenge exists and hasn't expired
    const challenge = this.challenges.get(nonce);
    if (!challenge) return null;
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(nonce);
      return null;
    }

    // Consume the nonce (one-time use)
    this.challenges.delete(nonce);

    // Check ERC-8004 registration if verifier is configured
    if (this.config.verifyRegistration) {
      const registered = await this.config.verifyRegistration(recoveredAddress);
      if (!registered) return null;
    }

    return this.createSession(playerId);
  }

  /**
   * Simple token-based auth (for transition period / dev mode).
   * Issues a session token directly for a player handle.
   */
  issueSimpleToken(playerId: string): SessionToken {
    // Revoke any existing session for this player
    const existingToken = this.playerSessions.get(playerId);
    if (existingToken) {
      this.sessions.delete(existingToken);
    }

    return this.createSession(playerId);
  }

  /**
   * Validate a session token. Returns the playerId if valid, null otherwise.
   */
  validateToken(token: string): string | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      this.playerSessions.delete(session.playerId);
      return null;
    }
    return session.playerId;
  }

  /**
   * Revoke a session token.
   */
  revokeToken(token: string): void {
    const session = this.sessions.get(token);
    if (session) {
      this.playerSessions.delete(session.playerId);
      this.sessions.delete(token);
    }
  }

  /**
   * Get all active sessions (for debugging / admin).
   */
  getActiveSessions(): SessionToken[] {
    const now = Date.now();
    const active: SessionToken[] = [];
    for (const session of this.sessions.values()) {
      if (session.expiresAt > now) {
        active.push(session);
      }
    }
    return active;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private createSession(playerId: string): SessionToken {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.config.sessionTtlMs;
    const session: SessionToken = { token, playerId, expiresAt };

    this.sessions.set(token, session);
    this.playerSessions.set(playerId, token);

    return session;
  }

  private cleanupChallenges(): void {
    const now = Date.now();
    for (const [nonce, challenge] of this.challenges) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(nonce);
      }
    }
  }
}
