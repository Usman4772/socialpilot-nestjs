import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { JwtAuthUser } from '../auth.types';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtAuthUser => {
    const request = ctx.switchToHttp().getRequest<{ user: JwtAuthUser }>();
    return request.user;
  },
);
