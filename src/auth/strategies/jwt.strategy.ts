import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UsersService } from '../../users/users.service';
import { JwtAuthUser } from '../auth.types';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET', 'local_dev_secret'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtAuthUser> {
    const user = await this.usersService.findById(payload.sub);
    if (!user || user.isDeleted) {
      throw new UnauthorizedException('Account is not available');
    }

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
    };
  }
}
