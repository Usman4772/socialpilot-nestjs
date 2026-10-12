import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { SkipOriginCheck } from './auth/decorators/skip-origin-check.decorator';

@ApiTags('Health')
@Controller()
export class AppController {
  @Get()
  @SkipThrottle()
  @SkipOriginCheck()
  health() {
    return { ok: true, service: 'social-hub-api' };
  }
}
