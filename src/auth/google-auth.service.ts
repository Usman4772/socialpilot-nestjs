import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { OAuth2Client } from 'google-auth-library';
import { createHash, randomBytes } from 'crypto';
import { Model } from 'mongoose';

import { UsersService } from '../users/users.service';
import { AuthUserResponse } from './auth.types';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { LoginSession, LoginSessionDocument } from './schemas/login-session.schema';

type GoogleStatePayload = {
  intent: 'login';
  nonce: string;
};

type GoogleProfile = {
  googleId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  pictureUrl: string | null;
};

export type GoogleExchangeResult = {
  accessToken: string;
  user: AuthUserResponse;
};

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly oauthClient: OAuth2Client | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    @InjectModel(LoginSession.name)
    private readonly loginSessionModel: Model<LoginSessionDocument>,
  ) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const clientSecret = this.configService.get<string>('GOOGLE_CLIENT_SECRET')?.trim();
    const callbackUrl = this.getCallbackUrl();
    this.oauthClient =
      clientId && clientSecret
        ? new OAuth2Client(clientId, clientSecret, callbackUrl)
        : null;
  }

  isConfigured(): boolean {
    return this.oauthClient !== null;
  }

  private getCallbackUrl(): string {
    const explicit = this.configService.get<string>('GOOGLE_CALLBACK_URL')?.trim();
    if (explicit) {
      return explicit.replace(/\/$/, '');
    }
    const base = (
      this.configService.get<string>('APP_BASE_URL') ||
      `http://localhost:${this.configService.get<string>('PORT') || '3040'}`
    ).replace(/\/$/, '');
    return `${base}/auth/google/callback`;
  }

  private getFrontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3010'
    ).replace(/\/$/, '');
  }

  private assertConfigured(): OAuth2Client {
    if (!this.oauthClient) {
      throw new BadRequestException('Google sign-in is not configured');
    }
    return this.oauthClient;
  }

  private hashSessionId(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex');
  }

  private getLoginSessionTtlMs(): number {
    const minutes = Number(
      this.configService.get<string>('LOGIN_SESSION_EXPIRES_MINUTES') ?? '10',
    );
    const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
    return safeMinutes * 60 * 1000;
  }

  buildAuthorizationUrl(): string {
    const client = this.assertConfigured();
    const state = this.jwtService.sign(
      { intent: 'login', nonce: randomBytes(16).toString('hex') } satisfies GoogleStatePayload,
      { expiresIn: '10m' },
    );
    return client.generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    });
  }

  private parseState(state: string | undefined): GoogleStatePayload {
    if (!state?.trim()) {
      throw new BadRequestException('Missing Google OAuth state');
    }
    try {
      const payload = this.jwtService.verify<GoogleStatePayload>(state.trim());
      if (payload.intent !== 'login' || !payload.nonce) {
        throw new Error('invalid intent');
      }
      return payload;
    } catch {
      throw new BadRequestException('Invalid or expired Google OAuth state');
    }
  }

  private async fetchGoogleProfile(code: string): Promise<GoogleProfile> {
    const client = this.assertConfigured();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const ticket = tokens.id_token
      ? await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: this.configService.get<string>('GOOGLE_CLIENT_ID')?.trim(),
        })
      : null;

    const payload = ticket?.getPayload();
    if (payload?.sub && payload.email && payload.email_verified !== false) {
      return {
        googleId: payload.sub,
        email: payload.email.trim().toLowerCase(),
        firstName: payload.given_name?.trim() || null,
        lastName: payload.family_name?.trim() || null,
        pictureUrl: payload.picture?.trim() || null,
      };
    }

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userInfoRes.ok) {
      throw new UnauthorizedException('Could not load Google profile');
    }
    const info = (await userInfoRes.json()) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      given_name?: string;
      family_name?: string;
      picture?: string;
    };
    if (!info.sub || !info.email || info.email_verified === false) {
      throw new UnauthorizedException('Google account did not return a verified email');
    }
    return {
      googleId: info.sub,
      email: info.email.trim().toLowerCase(),
      firstName: info.given_name?.trim() || null,
      lastName: info.family_name?.trim() || null,
      pictureUrl: info.picture?.trim() || null,
    };
  }

  private async createExchangeCode(userId: string): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const sessionHash = this.hashSessionId(`login:${raw}`);
    const expiresAt = new Date(Date.now() + this.getLoginSessionTtlMs());
    await this.loginSessionModel.create({
      userId,
      sessionHash,
      expiresAt,
    });
    return `login.${raw}`;
  }

  private parseExchangeCode(code: string): string {
    const trimmed = code?.trim();
    if (!trimmed) {
      throw new BadRequestException('Exchange code is required');
    }
    const dot = trimmed.indexOf('.');
    if (dot <= 0) {
      throw new BadRequestException('Invalid exchange code');
    }
    const intent = trimmed.slice(0, dot);
    const raw = trimmed.slice(dot + 1);
    if (intent !== 'login' || !raw) {
      throw new BadRequestException('Invalid exchange code');
    }
    return raw;
  }

  async handleCallback(params: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<{ redirectUrl: string }> {
    const frontend = this.getFrontendUrl();

    if (params.error) {
      this.logger.warn(`Google OAuth error from provider: ${params.error}`);
      return {
        redirectUrl: `${frontend}/login?googleError=${encodeURIComponent(
          'Google sign-in was cancelled or failed.',
        )}`,
      };
    }

    try {
      this.parseState(params.state);
      if (!params.code?.trim()) {
        throw new BadRequestException('Missing Google authorization code');
      }

      const profile = await this.fetchGoogleProfile(params.code.trim());
      const user = await this.usersService.upsertFromGoogle(profile);
      const exchangeCode = await this.createExchangeCode(user.id);
      return {
        redirectUrl: `${frontend}/auth/google/callback?code=${encodeURIComponent(exchangeCode)}`,
      };
    } catch (err) {
      const message =
        err instanceof BadRequestException || err instanceof UnauthorizedException
          ? (err.message as string)
          : 'Google sign-in failed. Please try again.';
      this.logger.warn(`Google OAuth callback failed: ${message}`);
      return {
        redirectUrl: `${frontend}/login?googleError=${encodeURIComponent(message)}`,
      };
    }
  }

  async exchangeCode(code: string): Promise<GoogleExchangeResult> {
    const raw = this.parseExchangeCode(code);
    const sessionHash = this.hashSessionId(`login:${raw}`);
    const session = await this.loginSessionModel.findOne({ sessionHash }).exec();

    if (!session || session.usedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Google sign-in session is invalid or has expired');
    }

    session.usedAt = new Date();
    await session.save();

    const user = await this.usersService.findById(session.userId);
    if (!user || user.isDeleted) {
      throw new UnauthorizedException('Account is not available');
    }

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      email: user.email,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: this.usersService.toAuthUser(user),
    };
  }
}
