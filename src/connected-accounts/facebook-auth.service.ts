import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';

import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ConnectedAccountsService } from './connected-accounts.service';

type FacebookState = {
  intent: 'facebook_connect';
  userId: string;
  workspaceId: string;
  nonce: string;
};

type GraphErrorBody = {
  error?: { message?: string; code?: number; type?: string };
};

type FacebookPageResponse = {
  id: string;
  name?: string;
  username?: string;
  access_token?: string;
  category?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
};

const DEFAULT_SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_engagement',
  'pages_read_user_content',
  'business_management',
  'public_profile',
];

@Injectable()
export class FacebookAuthService {
  private readonly logger = new Logger(FacebookAuthService.name);

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
        intent: 'facebook_connect',
        userId: user.id,
        workspaceId: workspace.id,
        nonce: randomBytes(16).toString('hex'),
      } satisfies FacebookState,
      { expiresIn: '10m' },
    );

    const params = new URLSearchParams({
      client_id: this.appId(),
      redirect_uri: this.callbackUrl(),
      state,
      response_type: 'code',
      auth_type: 'rerequest',
    });
    const configId = this.configService.get<string>('FACEBOOK_LOGIN_CONFIG_ID')?.trim();
    if (configId) {
      params.set('config_id', configId);
    } else {
      params.set('scope', DEFAULT_SCOPES.join(','));
    }
    return `https://www.facebook.com/${this.graphVersion()}/dialog/oauth?${params.toString()}`;
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ redirectUrl: string }> {
    const frontend = this.frontendUrl();
    if (params.error) {
      const message = params.errorDescription?.trim() || 'Facebook connection was cancelled.';
      this.logger.warn(`Facebook OAuth error: ${params.error}`);
      return { redirectUrl: this.accountsRedirect(frontend, { facebookError: message }) };
    }

    try {
      const state = this.parseState(params.state);
      if (!params.code?.trim()) {
        throw new BadRequestException('Missing Facebook authorization code');
      }
      const userToken = await this.exchangeCode(params.code.trim());
      const profile = await this.fetchJson<{ id: string; name?: string }>(
        `/${this.graphVersion()}/me`,
        userToken,
        { fields: 'id,name' },
      );
      const pages = await this.listPages(userToken);
      if (pages.length === 0) {
        throw new BadRequestException(
          'Facebook did not share any Pages. Choose at least one Page you manage in the permission dialog.',
        );
      }

      await this.connectedAccountsService.saveFacebookPages(
        state.workspaceId,
        state.userId,
        pages.map((page) => ({
          accountId: page.id,
          name: page.name?.trim() || 'Facebook Page',
          username: page.username?.trim() || null,
          profileImageUrl: page.picture?.data?.url?.trim() || null,
          category: page.category?.trim() || null,
          accessToken: page.access_token as string,
          tasks: page.tasks ?? [],
          permissions: DEFAULT_SCOPES,
          authorizedByFacebookUserId: profile.id,
          connectedByUserId: state.userId,
        })),
      );

      return {
        redirectUrl: this.accountsRedirect(frontend, {
          facebook: 'connected',
          pages: String(pages.length),
        }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Facebook connection failed.';
      this.logger.warn(`Facebook callback failed: ${message}`);
      return { redirectUrl: this.accountsRedirect(frontend, { facebookError: message }) };
    }
  }

  private async exchangeCode(code: string): Promise<string> {
    const shortLived = await this.fetchToken({
      client_id: this.appId(),
      client_secret: this.appSecret(),
      redirect_uri: this.callbackUrl(),
      code,
    });
    try {
      const longLived = await this.fetchToken({
        grant_type: 'fb_exchange_token',
        client_id: this.appId(),
        client_secret: this.appSecret(),
        fb_exchange_token: shortLived,
      });
      return longLived;
    } catch (err) {
      this.logger.warn(
        `Long-lived Facebook token exchange failed, using the short-lived token: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return shortLived;
    }
  }

  private async listPages(userToken: string): Promise<FacebookPageResponse[]> {
    const pages: FacebookPageResponse[] = [];
    let nextUrl: string | null =
      `https://graph.facebook.com/${this.graphVersion()}/me/accounts?` +
      new URLSearchParams({
        fields: 'id,name,username,access_token,tasks,category,picture.type(large){url}',
        limit: '50',
        access_token: userToken,
      }).toString();

    while (nextUrl && pages.length < 100) {
      const body = await this.fetchAbsolute<{
        data?: FacebookPageResponse[];
        paging?: { next?: string };
      }>(nextUrl);
      for (const page of body.data ?? []) {
        if (page.id && page.access_token) {
          pages.push(page);
        }
      }
      nextUrl = body.paging?.next ?? null;
    }
    return pages;
  }

  private async fetchToken(params: Record<string, string>): Promise<string> {
    const url = `https://graph.facebook.com/${this.graphVersion()}/oauth/access_token?${new URLSearchParams(params)}`;
    const body = await this.fetchAbsolute<{ access_token?: string } & GraphErrorBody>(url);
    if (!body.access_token) {
      throw new BadRequestException(body.error?.message || 'Facebook did not return an access token');
    }
    return body.access_token;
  }

  private async fetchJson<T>(path: string, accessToken: string, query: Record<string, string>): Promise<T> {
    const params = new URLSearchParams({ ...query, access_token: accessToken });
    return this.fetchAbsolute<T>(`https://graph.facebook.com${path}?${params}`);
  }

  private async fetchAbsolute<T>(url: string): Promise<T> {
    const response = await fetch(url);
    const body = (await response.json()) as T & GraphErrorBody;
    if (!response.ok || body.error) {
      throw new BadRequestException(body.error?.message || 'Facebook request failed');
    }
    return body;
  }

  private parseState(state: string | undefined): FacebookState {
    if (!state?.trim()) {
      throw new BadRequestException('Missing Facebook OAuth state');
    }
    try {
      const payload = this.jwtService.verify<FacebookState>(state.trim());
      if (payload.intent !== 'facebook_connect' || !payload.userId || !payload.workspaceId) {
        throw new Error('invalid intent');
      }
      return payload;
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      throw new BadRequestException('Invalid or expired Facebook connection request. Start again from Accounts.');
    }
  }

  private accountsRedirect(frontend: string, query: Record<string, string>): string {
    const params = new URLSearchParams(query);
    return `${frontend}/accounts?${params.toString()}`;
  }

  private appId(): string {
    const value = this.configService.get<string>('FACEBOOK_APP_ID')?.trim();
    if (!value) {
      throw new BadRequestException('FACEBOOK_APP_ID is not configured');
    }
    return value;
  }

  private appSecret(): string {
    const value = this.configService.get<string>('FACEBOOK_APP_SECRET')?.trim();
    if (!value) {
      throw new BadRequestException('FACEBOOK_APP_SECRET is not configured');
    }
    return value;
  }

  private callbackUrl(): string {
    const explicit = this.configService.get<string>('FACEBOOK_CALLBACK_URL')?.trim();
    if (explicit) {
      return explicit.replace(/\/$/, '');
    }
    const port = this.configService.get<string>('PORT') || '3030';
    return `http://localhost:${port}/auth/facebook/callback`;
  }

  private frontendUrl(): string {
    return (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/$/, '');
  }

  private graphVersion(): string {
    return (this.configService.get<string>('FACEBOOK_GRAPH_VERSION') || 'v23.0').replace(/^\/+|\/+$/g, '');
  }
}
