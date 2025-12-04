import { randomBytes } from 'crypto';

interface TokenData {
  sessionId: string;
  createdAt: number;
  used: boolean;
  connectionActive: boolean;
}

class TokenStore {
  private tokens: Map<string, TokenData> = new Map();
  private readonly TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes (short window)

  generateToken(sessionId: string): string {
    // Generate a cryptographically secure random token
    const token = randomBytes(32).toString('base64url');
    
    this.tokens.set(token, {
      sessionId,
      createdAt: Date.now(),
      used: false,
      connectionActive: true
    });

    return token;
  }

  validateAndUseToken(token: string): { valid: boolean; sessionId?: string } {
    const data = this.tokens.get(token);
    
    if (!data) {
      return { valid: false };
    }

    // Check if already used (one-time use)
    if (data.used) {
      return { valid: false };
    }

    // Check if connection is still active
    if (!data.connectionActive) {
      return { valid: false };
    }

    // Check if token is expired
    if (Date.now() - data.createdAt > this.TOKEN_EXPIRY_MS) {
      this.tokens.delete(token);
      return { valid: false };
    }

    // Mark as used (one-time use)
    data.used = true;

    return { valid: true, sessionId: data.sessionId };
  }

  markConnectionClosed(sessionId: string): void {
    // Mark all tokens for this session as having inactive connection
    for (const [, data] of this.tokens.entries()) {
      if (data.sessionId === sessionId) {
        data.connectionActive = false;
      }
    }
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  revokeSessionTokens(sessionId: string): void {
    for (const [token, data] of this.tokens.entries()) {
      if (data.sessionId === sessionId) {
        this.tokens.delete(token);
      }
    }
  }

  // Clean up expired tokens periodically
  cleanup(): void {
    const now = Date.now();
    for (const [token, data] of this.tokens.entries()) {
      if (now - data.createdAt > this.TOKEN_EXPIRY_MS) {
        this.tokens.delete(token);
      }
    }
  }
}

// Singleton instance
export const tokenStore = new TokenStore();

// Run cleanup every 10 minutes
setInterval(() => {
  tokenStore.cleanup();
}, 10 * 60 * 1000);

