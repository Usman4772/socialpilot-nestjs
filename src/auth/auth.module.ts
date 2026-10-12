import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import type { StringValue } from 'ms';

import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { LoginSession, LoginSessionSchema } from './schemas/login-session.schema';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    UsersModule,
    ConnectedAccountsModule,
    MongooseModule.forFeature([
      { name: LoginSession.name, schema: LoginSessionSchema },
    ]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const expiresIn = (configService.get<string>('JWT_EXPIRES_IN') ??
          '7d') as StringValue;

        return {
          secret: configService.get<string>('JWT_SECRET', 'local_dev_secret'),
          signOptions: { expiresIn },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [GoogleAuthService, JwtStrategy],
  exports: [GoogleAuthService],
})
export class AuthModule {}
