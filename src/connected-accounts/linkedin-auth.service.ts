import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';

import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ConnectedAccountsService } from './connected-accounts.service';

type LinkedInState = {
  intent: 'linkedin_connect';
  userId: string;
  workspaceId: string;
  nonce: string;
};

type LinkedInErrorBody = {
  error?: string;
  error_description?: string;
  message?: string;
};

type LinkedInTokenResponse = LinkedInErrorBody & {
  access_token?: string;
  expires_in?: number;
};

type LinkedInProfile = LinkedInErrorBody & {
  sub?: string;
  name?: string;
  email?: string;
  picture?: string;
};

const SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

@Injectable()
export class LinkedInAuthService {
  private readonly logger = new Logger(LinkedInAuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly workspacesService: WorkspacesService,
    private readonly connectedAccountsService: ConnectedAccountsService,
  ) {}

  async buildAuthorizationUrl(userId: string): Promise<string> {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new BadRequestException('Account is not available');
    }
    const workspace = await this.workspacesService.ensureForUser(user);
    const state = this.jwtService.sign(
      {
        intent: 'linkedin_connect',
        userId: user.id,
        workspaceId: workspace.id,
        nonce: randomBytes(16).toString('hex'),
      } satisfies LinkedInState,
      { expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId(),
      redirect_uri: this.callbackUrl(),
      state,
      scope: SCOPES.join(' '),
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ redirectUrl: string }> {
    const frontend = this.frontendUrl();
    if (params.error) {
      const message = params.errorDescription?.trim() || 'LinkedIn connection was cancelled.';
      this.logger.warn(`LinkedIn OAuth error: ${params.error}`);
      return { redirectUrl: this.accountsRedirect(frontend, { linkedinError: message }) };
    }

    try {
      const state = this.parseState(params.state);
      const code = params.code?.trim();
      if (!code) {
        throw new BadRequestException('Missing LinkedIn authorization code');
      }
      const token = await this.exchangeCode(code);
      const profile = await this.fetchProfile(token.accessToken);
      const accountId = profile.sub?.trim();
      if (!accountId) {
        throw new BadRequestException('LinkedIn did not return the member profile.');
      }
      await this.connectedAccountsService.saveLinkedInMember(state.workspaceId, state.userId, {
        accountId,
        name: profile.name?.trim() || 'LinkedIn',
        email: profile.email?.trim() || null,
        profileImageUrl: profile.picture?.trim() || null,
        accessToken: token.accessToken,
        tokenExpiresAt: token.expiresAt,
      });
      return { redirectUrl: this.accountsRedirect(frontend, { linkedin: 'connected' }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LinkedIn connection failed';
      this.logger.warn(`LinkedIn connect failed: ${message}`);
      return { redirectUrl: this.accountsRedirect(frontend, { linkedinError: message }) };
    }
  }

  private async exchangeCode(code: string): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl(),
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
    });
    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await response.json()) as LinkedInTokenResponse;
    if (!response.ok || !payload.access_token) {
      throw new BadRequestException(payload.error_description || payload.message || 'LinkedIn did not grant access.');
    }
    const expiresAt =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? new Date(Date.now() + payload.expires_in * 1000)
        : null;
    return { accessToken: payload.access_token, expiresAt };
  }

  private async fetchProfile(accessToken: string): Promise<LinkedInProfile> {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json()) as LinkedInProfile;
    if (!response.ok) {
      throw new BadRequestException(payload.error_description || payload.message || 'LinkedIn did not return the profile.');
    }
    return payload;
  }

  private parseState(value: string | undefined): LinkedInState {
    if (!value) {
      throw new BadRequestException('Missing LinkedIn connection state. Start again from Accounts.');
    }
    try {
      const payload = this.jwtService.verify<LinkedInState>(value);
      if (payload.intent !== 'linkedin_connect' || !payload.userId || !payload.workspaceId) {
        throw new BadRequestException('Invalid LinkedIn connection request.');
      }
      return payload;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid or expired LinkedIn connection request. Start again from Accounts.');
    }
  }

  private accountsRedirect(frontend: string, query: Record<string, string>): string {
    const params = new URLSearchParams(query);
    return `${frontend}/accounts?${params.toString()}`;
  }

  private clientId(): string {
    const value = this.configService.get<string>('LINKEDIN_CLIENT_ID')?.trim();
    if (!value) throw new BadRequestException('LINKEDIN_CLIENT_ID is not configured');
    return value;
  }

  private clientSecret(): string {
    const value = this.configService.get<string>('LINKEDIN_CLIENT_SECRET')?.trim();
    if (!value) throw new BadRequestException('LINKEDIN_CLIENT_SECRET is not configured');
    return value;
  }

  private callbackUrl(): string {
    const explicit = this.configService.get<string>('LINKEDIN_CALLBACK_URL')?.trim();
    if (explicit) return explicit;
    const port = this.configService.get<string>('PORT') || '3030';
    return `http://localhost:${port}/auth/linkedin/callback`;
  }

  private frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/$/, '');
  }
}
