import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import type { JwtAuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from '../users/users.service';
import { ConnectedAccountsService } from './connected-accounts.service';
import { FacebookAuthService } from './facebook-auth.service';

@ApiTags('Connected accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('connected-accounts')
export class ConnectedAccountsController {
  constructor(
    private readonly usersService: UsersService,
    private readonly connectedAccountsService: ConnectedAccountsService,
    private readonly facebookAuthService: FacebookAuthService,
  ) {}

  @Get()
  async list(@CurrentUser() authUser: JwtAuthUser) {
    const user = await this.usersService.findById(authUser.userId);
    if (!user) {
      return this.connectedAccountsService.toPublic(null, null);
    }
    const membership = user.workspaces?.find((item) => item.status === 'active');
    if (!membership) {
      return this.connectedAccountsService.toPublic(null, null);
    }
    const doc = await this.connectedAccountsService.findByWorkspace(membership.workspaceId);
    return this.connectedAccountsService.toPublic(doc, membership.workspaceId);
  }

  @Get('facebook/start')
  async startFacebook(@CurrentUser() authUser: JwtAuthUser) {
    const url = await this.facebookAuthService.buildAuthorizationUrl(authUser.userId);
    return { url };
  }

  @Delete('facebook/:pageId')
  async disconnectFacebook(@CurrentUser() authUser: JwtAuthUser, @Param('pageId') pageId: string) {
    const user = await this.usersService.findById(authUser.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) {
      return this.connectedAccountsService.toPublic(null, null);
    }
    await this.connectedAccountsService.disconnectFacebookPage(membership.workspaceId, pageId);
    const doc = await this.connectedAccountsService.findByWorkspace(membership.workspaceId);
    return this.connectedAccountsService.toPublic(doc, membership.workspaceId);
  }
}
