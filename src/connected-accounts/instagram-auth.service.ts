import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';

import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ConnectedAccountsService } from './connected-accounts.service';

type InstagramState = {
  intent: 'instagram_connect';
  userId: string;
  workspaceId: string;
  nonce: string;
};

type InstagramErrorBody = {
  error_message?: string;
  error_type?: string;
  error?: { message?: string };
};

type ShortTokenResponse = InstagramErrorBody & {
  access_token?: string;
  user_id?: string | number;
  data?: Array<{ access_token?: string; user_id?: string | number }>;
};

type LongTokenResponse = InstagramErrorBody & {
  access_token?: string;
  expires_in?: number;
};

type InstagramProfile = {
  id?: string;
  user_id?: string | number;
  username?: string;
  name?: string;
  profile_picture_url?: string;
  account_type?: string;
};

const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments'];

@Injectable()
export class InstagramAuthService {
  private readonly logger = new Logger(InstagramAuthService.name);

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
        intent: 'instagram_connect',
        userId: user.id,
        workspaceId: workspace.id,
        nonce: randomBytes(16).toString('hex'),
      } satisfies InstagramState,
      { expiresIn: '10m' },
    );

    const params = new URLSearchParams({
      client_id: this.appId(),
      redirect_uri: this.callbackUrl(),
      response_type: 'code',
      scope: SCOPES.join(','),
      state,
      enable_fb_login: 'false',
    });
    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    errorReason?: string;
    errorDescription?: string;
  }): Promise<{ redirectUrl: string }> {
    const frontend = this.frontendUrl();
    if (params.error) {
      const message = params.errorDescription?.trim() || 'Instagram connection was cancelled.';
      this.logger.warn(`Instagram OAuth error: ${params.error}`);
      return { redirectUrl: this.accountsRedirect(frontend, { instagramError: message }) };
    }

    try {
      const state = this.parseState(params.state);
      const code = params.code?.trim().replace(/#_$/, '');
      if (!code) {
        throw new BadRequestException('Missing Instagram authorization code');
      }
      const shortLived = await this.exchangeCode(code);
      const longLived = await this.exchangeLongLived(shortLived.accessToken);
      const profile = await this.fetchProfile(longLived.accessToken);
      const accountType = profile.account_type?.trim().toUpperCase();
      if (accountType === 'PERSONAL') {
        throw new BadRequestException(
          'Instagram login needs a Professional account. Switch this account to Professional, then connect again.',
        );
      }
      const accountId = String(profile.user_id || profile.id || shortLived.userId);
      const username = profile.username?.trim() || null;
      await this.connectedAccountsService.saveInstagramLoginAccount(state.workspaceId, state.userId, {
        accountId,
        name: profile.name?.trim() || username || 'Instagram',
        username,
        profileImageUrl: profile.profile_picture_url?.trim() || null,
        accessToken: longLived.accessToken,
        tokenExpiresAt: longLived.expiresAt,
      });
      return { redirectUrl: this.accountsRedirect(frontend, { instagramLogin: 'connected' }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Instagram connection failed.';
      this.logger.warn(`Instagram callback failed: ${message}`);
      return { redirectUrl: this.accountsRedirect(frontend, { instagramError: message }) };
    }
  }

  private async exchangeCode(code: string): Promise<{ accessToken: string; userId: string }> {
    const form = new FormData();
    form.set('client_id', this.appId());
    form.set('client_secret', this.appSecret());
    form.set('grant_type', 'authorization_code');
    form.set('redirect_uri', this.callbackUrl());
    form.set('code', code);
    const body = await this.fetchAbsolute<ShortTokenResponse>('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: form,
    });
    const token = body.data?.[0] ?? body;
    if (!token.access_token) {
      throw new BadRequestException(this.errorMessage(body, 'Instagram did not return an access token'));
    }
    return { accessToken: token.access_token, userId: String(token.user_id ?? '') };
  }

  private async exchangeLongLived(shortLivedToken: string): Promise<{ accessToken: string; expiresAt: Date | null }> {
    const params = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: this.appSecret(),
      access_token: shortLivedToken,
    });
    try {
      const body = await this.fetchAbsolute<LongTokenResponse>(
        `https://graph.instagram.com/access_token?${params.toString()}`,
      );
      if (!body.access_token) {
        throw new BadRequestException(this.errorMessage(body, 'Instagram did not return a long-lived token'));
      }
      const expiresAt =
        typeof body.expires_in === 'number' ? new Date(Date.now() + body.expires_in * 1000) : null;
      return { accessToken: body.access_token, expiresAt };
    } catch (err) {
      this.logger.warn(
        `Long-lived Instagram token exchange failed, using the short-lived token: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return { accessToken: shortLivedToken, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
    }
  }

  private async fetchProfile(accessToken: string): Promise<InstagramProfile> {
    const fields = 'user_id,username,name,profile_picture_url,account_type';
    try {
      return await this.fetchProfileFields(accessToken, fields);
    } catch (err) {
      this.logger.warn(
        `Instagram profile fields failed, retrying without account type: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return this.fetchProfileFields(accessToken, 'user_id,username,name,profile_picture_url');
    }
  }

  private async fetchProfileFields(accessToken: string, fields: string): Promise<InstagramProfile> {
    const params = new URLSearchParams({ fields, access_token: accessToken });
    return this.fetchAbsolute<InstagramProfile>(`https://graph.instagram.com/me?${params.toString()}`);
  }

  private async fetchAbsolute<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const body = (await response.json()) as T & InstagramErrorBody;
    if (!response.ok || body.error_message || body.error) {
      throw new BadRequestException(this.errorMessage(body, 'Instagram request failed'));
    }
    return body;
  }

  private errorMessage(body: InstagramErrorBody, fallback: string): string {
    const message = body.error_message || body.error?.message || fallback;
    if (/access_token|client_secret|secret/i.test(message)) {
      return fallback;
    }
    return message.slice(0, 200);
  }

  private parseState(state: string | undefined): InstagramState {
    if (!state?.trim()) {
      throw new BadRequestException('Missing Instagram OAuth state');
    }
    try {
      const payload = this.jwtService.verify<InstagramState>(state.trim());
      if (payload.intent !== 'instagram_connect' || !payload.userId || !payload.workspaceId) {
        throw new Error('invalid intent');
      }
      return payload;
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      throw new BadRequestException('Invalid or expired Instagram connection request. Start again from Accounts.');
    }
  }

  private accountsRedirect(frontend: string, query: Record<string, string>): string {
    const params = new URLSearchParams(query);
    return `${frontend}/accounts?${params.toString()}`;
  }

  private appId(): string {
    const value = this.configService.get<string>('INSTAGRAM_APP_ID')?.trim();
    if (!value) {
      throw new BadRequestException('INSTAGRAM_APP_ID is not configured');
    }
    return value;
  }

  private appSecret(): string {
    const value = this.configService.get<string>('INSTAGRAM_APP_SECRET')?.trim();
    if (!value) {
      throw new BadRequestException('INSTAGRAM_APP_SECRET is not configured');
    }
    return value;
  }

  private callbackUrl(): string {
    // Loaded when the API starts. Restart the API after changing this in .env.
    const explicit = this.configService.get<string>('INSTAGRAM_CALLBACK_URL')?.trim();
    if (explicit) {
      return explicit;
    }
    const port = this.configService.get<string>('PORT') || '3030';
    return `http://localhost:${port}/auth/instagram/callback`;
  }

  private frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/$/, '');
  }
}
