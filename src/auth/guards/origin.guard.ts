import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import {
  isOriginAllowed,
  parseAllowedOrigins,
  resolveRequestOrigin,
} from '../../common/utils/allowed-origins.util';
import { SKIP_ORIGIN_CHECK_KEY } from '../decorators/skip-origin-check.decorator';

const EXEMPT_PATH_PREFIXES = ['/auth/google', '/auth/facebook'];

/**
 * When ENFORCE_ORIGIN_CHECK=true, rejects browser requests whose Origin/Referer
 * is not in ALLOWED_ORIGINS (plus FRONTEND_URL).
 *
 * Google's browser redirect has no app origin, so /auth/google/* is exempt.
 * Requests with no Origin/Referer (curl, server-to-server) are allowed.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.configService.get<string>('ENFORCE_ORIGIN_CHECK') !== 'true') {
      return true;
    }

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ORIGIN_CHECK_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (this.isExemptPath(request.path)) {
      return true;
    }

    const requestOrigin = resolveRequestOrigin(
      request.headers.origin,
      request.headers.referer,
    );

    if (!requestOrigin) {
      return true;
    }

    const allowedOrigins = parseAllowedOrigins(
      this.configService.get<string>('ALLOWED_ORIGINS'),
      this.configService.get<string>('FRONTEND_URL'),
    );

    if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
      throw new ForbiddenException('Origin not allowed');
    }

    return true;
  }

  private isExemptPath(path: string): boolean {
    return EXEMPT_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }
}
