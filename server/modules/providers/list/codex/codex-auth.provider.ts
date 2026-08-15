import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class CodexProviderAuth implements IProviderAuth {
  /**
   * Aureon executes Codex through @openai/codex-sdk, so a Codex CLI binary is
   * not required on Render. The SDK is part of the application dependency set.
   */
  private checkInstalled(): boolean {
    return true;
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  private getCodexHome(): string {
    const configuredHome = process.env.CODEX_HOME?.trim();
    return configuredHome ? path.resolve(configuredHome) : path.join(os.homedir(), '.codex');
  }

  /**
   * Authentication sources, in priority order:
   * 1. Render/server OPENAI_API_KEY environment secret.
   * 2. A Codex auth.json created by a local/desktop Codex login.
   *
   * Secrets are never returned to the client.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (apiKey) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    try {
      const authPath = path.join(this.getCodexHome(), 'auth.json');
      const content = await readFile(authPath, 'utf8');
      const auth = readObjectRecord(JSON.parse(content)) ?? {};
      const tokens = readObjectRecord(auth.tokens) ?? {};
      const idToken = readOptionalString(tokens.id_token);
      const accessToken = readOptionalString(tokens.access_token);

      if (idToken || accessToken) {
        return {
          authenticated: true,
          email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
          method: 'credentials_file',
        };
      }

      if (readOptionalString(auth.OPENAI_API_KEY)) {
        return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
      }

      return { authenticated: false, email: null, method: null, error: 'No valid Codex credentials found' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT'
          ? 'Codex not configured. Add OPENAI_API_KEY to the server environment or authenticate Codex on the desktop.'
          : error instanceof Error ? error.message : 'Failed to read Codex auth',
      };
    }
  }

  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}
