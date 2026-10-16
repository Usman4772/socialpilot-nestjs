import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';

import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ConnectedAccountsService } from './connected-accounts.service';

type TikTokState = {
  intent: 'tiktok_connect';
  userId: string;
  workspaceId: string;
  nonce: string;
  verifier: string;
};

type TikTokTokenResponse = {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_token?: string;
  refresh_expires_in?: number;
  error?: string;
  error_description?: string;
  message?: string;
};

type TikTokUser = {
  open_id?: string;
  display_name?: string;
  username?: string;
  avatar_url?: string;
};

type TikTokUserResponse = {
  data?: { user?: TikTokUser };
  error?: { code?: string; message?: string };
};

const SCOPES = ['user.info.basic', 'user.info.profile', 'video.upload'];

@Injectable()
export class TikTokAuthService {
  private readonly logger = new Logger(TikTokAuthService.name);

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
    const verifier = randomBytes(32).toString('base64url');
    const state = this.jwtService.sign(
      {
        intent: 'tiktok_connect',
        userId: user.id,
        workspaceId: workspace.id,
        nonce: randomBytes(16).toString('hex'),
        verifier,
      } satisfies TikTokState,
      { expiresIn: '10m' },
    );
    const params = new URLSearchParams({
      client_key: this.clientId(),
      response_type: 'code',
      scope: SCOPES.join(','),
      redirect_uri: this.callbackUrl(),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ redirectUrl: string }> {
    const frontend = this.frontendUrl();
    if (params.error) {
      const message = params.errorDescription?.trim() || 'TikTok connection was cancelled.';
      this.logger.warn(`TikTok OAuth error: ${params.error}`);
      return { redirectUrl: this.accountsRedirect(frontend, { tiktokError: message }) };
    }

    try {
      const state = this.parseState(params.state);
      const code = params.code?.trim();
      if (!code) {
        throw new BadRequestException('Missing TikTok authorization code');
      }
      const token = await this.exchangeCode(code, state.verifier);
      const profile = await this.fetchProfile(token.accessToken);
      const accountId = profile.open_id?.trim() || token.openId;
      if (!accountId) {
        throw new BadRequestException('TikTok did not return the account.');
      }
      await this.connectedAccountsService.saveTikTokAccount(state.workspaceId, state.userId, {
        accountId,
        name: profile.display_name?.trim() || profile.username?.trim() || 'TikTok',
        username: profile.username?.trim() || null,
        profileImageUrl: profile.avatar_url?.trim() || null,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        tokenExpiresAt: token.expiresAt,
        refreshExpiresAt: token.refreshExpiresAt,
      });
      return { redirectUrl: this.accountsRedirect(frontend, { tiktok: 'connected' }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'TikTok connection failed';
      this.logger.warn(`TikTok connect failed: ${message}`);
      return { redirectUrl: this.accountsRedirect(frontend, { tiktokError: message }) };
    }
  }

  private async exchangeCode(code: string, verifier: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    openId: string | null;
    expiresAt: Date | null;
    refreshExpiresAt: Date | null;
  }> {
    const body = new URLSearchParams({
      client_key: this.clientId(),
      client_secret: this.clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.callbackUrl(),
      code_verifier: verifier,
    });
    const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await response.json()) as TikTokTokenResponse;
    if (!response.ok || !payload.access_token) {
      throw new BadRequestException(payload.error_description || payload.message || payload.error || 'TikTok did not grant access.');
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token?.trim() || null,
      openId: payload.open_id?.trim() || null,
      expiresAt: this.expiry(payload.expires_in),
      refreshExpiresAt: this.expiry(payload.refresh_expires_in),
    };
  }

  private async fetchProfile(accessToken: string): Promise<TikTokUser> {
    const fields = 'open_id,display_name,username,avatar_url';
    const response = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${fields}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await response.json()) as TikTokUserResponse;
    if (!response.ok || (payload.error?.code && payload.error.code !== 'ok')) {
      throw new BadRequestException(payload.error?.message || 'TikTok did not return the profile.');
    }
    return payload.data?.user ?? {};
  }

  private expiry(seconds: number | undefined): Date | null {
    return typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
  }

  private parseState(value: string | undefined): TikTokState {
    if (!value) {
      throw new BadRequestException('Missing TikTok connection state. Start again from Accounts.');
    }
    try {
      const payload = this.jwtService.verify<TikTokState>(value);
      if (payload.intent !== 'tiktok_connect' || !payload.userId || !payload.workspaceId || !payload.verifier) {
        throw new BadRequestException('Invalid TikTok connection request.');
      }
      return payload;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid or expired TikTok connection request. Start again from Accounts.');
    }
  }

  private accountsRedirect(frontend: string, query: Record<string, string>): string {
    const params = new URLSearchParams(query);
    return `${frontend}/accounts?${params.toString()}`;
  }

  private clientId(): string {
    const value = this.configService.get<string>('TIKTOK_CLIENT_ID')?.trim();
    if (!value) throw new BadRequestException('TIKTOK_CLIENT_ID is not configured');
    return value;
  }

  private clientSecret(): string {
    const value = this.configService.get<string>('TIKTOK_CLIENT_SECRET')?.trim();
    if (!value) throw new BadRequestException('TIKTOK_CLIENT_SECRET is not configured');
    return value;
  }

  private callbackUrl(): string {
    const explicit = this.configService.get<string>('TIKTOK_CALLBACK_URL')?.trim();
    if (explicit) return explicit;
    const port = this.configService.get<string>('PORT') || '3030';
    return `http://localhost:${port}/auth/tiktok/callback`;
  }

  private frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/$/, '');
  }
}
