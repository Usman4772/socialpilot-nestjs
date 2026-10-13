import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import type { StringValue } from 'ms';

import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { ConnectedAccountsService } from './connected-accounts.service';
import { FacebookAuthService } from './facebook-auth.service';
import { InstagramAuthService } from './instagram-auth.service';
import {
  ConnectedAccounts,
  ConnectedAccountsSchema,
} from './schemas/connected-accounts.schema';

@Module({
  imports: [
    UsersModule,
    WorkspacesModule,
    MongooseModule.forFeature([
      { name: ConnectedAccounts.name, schema: ConnectedAccountsSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const expiresIn = (configService.get<string>('JWT_EXPIRES_IN') ?? '7d') as StringValue;
        return {
          secret: configService.get<string>('JWT_SECRET', 'local_dev_secret'),
          signOptions: { expiresIn },
        };
      },
    }),
  ],
  controllers: [ConnectedAccountsController],
  providers: [ConnectedAccountsService, FacebookAuthService, InstagramAuthService],
  exports: [FacebookAuthService, InstagramAuthService, ConnectedAccountsService],
})
export class ConnectedAccountsModule {}
