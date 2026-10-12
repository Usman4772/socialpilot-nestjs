import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { FacebookAuthService } from '../connected-accounts/facebook-auth.service';
import { SkipOriginCheck } from './decorators/skip-origin-check.decorator';
import { ExchangeGoogleDto } from './dto/exchange-google.dto';
import { GoogleAuthService } from './google-auth.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly facebookAuthService: FacebookAuthService,
  ) {}

  @Get('google')
  @SkipOriginCheck()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  startGoogleAuth(@Res() res: Response) {
    const url = this.googleAuthService.buildAuthorizationUrl();
    return res.redirect(url);
  }

  @Get('google/callback')
  @SkipOriginCheck()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const { redirectUrl } = await this.googleAuthService.handleCallback({
      code,
      state,
      error,
    });
    return res.redirect(redirectUrl);
  }

  @Post('google/exchange')
  @SkipOriginCheck()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiBody({ type: ExchangeGoogleDto })
  exchangeGoogle(@Body() dto: ExchangeGoogleDto) {
    return this.googleAuthService.exchangeCode(dto.code);
  }

  @Get('facebook/callback')
  @SkipOriginCheck()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async facebookCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ) {
    const { redirectUrl } = await this.facebookAuthService.handleCallback({
      code,
      state,
      error,
      errorDescription,
    });
    return res.redirect(redirectUrl);
  }
}
