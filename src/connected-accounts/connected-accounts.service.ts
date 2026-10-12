import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { decryptSecret, encryptSecret } from '../common/utils/token-cipher';
import {
  ConnectedAccounts,
  ConnectedAccountsDocument,
  FacebookPageAccount,
} from './schemas/connected-accounts.schema';

export type FacebookPageInput = {
  accountId: string;
  name: string;
  username?: string | null;
  profileImageUrl?: string | null;
  category?: string | null;
  accessToken: string;
  tasks: string[];
  permissions: string[];
  authorizedByFacebookUserId: string;
  connectedByUserId: string;
};

export type PublicFacebookPage = {
  id: string;
  accountId: string;
  name: string;
  username: string | null;
  profileImageUrl: string | null;
  category: string | null;
  status: FacebookPageAccount['status'];
  isDefault: boolean;
  tasks: string[];
  connectedAt: Date;
};

export type PublicConnectedAccounts = {
  workspaceId: string | null;
  facebook: PublicFacebookPage[];
  instagram: Record<string, unknown>[];
  linkedin: Record<string, unknown>[];
  tiktok: Record<string, unknown>[];
};

@Injectable()
export class ConnectedAccountsService {
  constructor(
    @InjectModel(ConnectedAccounts.name)
    private readonly connectedAccountsModel: Model<ConnectedAccountsDocument>,
    private readonly configService: ConfigService,
  ) {}

  async findByWorkspace(workspaceId: string): Promise<ConnectedAccountsDocument | null> {
    return this.connectedAccountsModel.findOne({ workspaceId }).exec();
  }

  toPublic(doc: ConnectedAccountsDocument | null, workspaceId: string | null): PublicConnectedAccounts {
    return {
      workspaceId,
      facebook: (doc?.facebook ?? [])
        .filter((page) => page.status !== 'disconnected')
        .map((page) => ({
          id: String(page._id),
          accountId: page.accountId,
          name: page.name,
          username: page.username ?? null,
          profileImageUrl: page.profileImageUrl ?? null,
          category: page.category ?? null,
          status: page.status,
          isDefault: page.isDefault,
          tasks: page.tasks ?? [],
          connectedAt: page.connectedAt,
        })),
      instagram: doc?.instagram ?? [],
      linkedin: doc?.linkedin ?? [],
      tiktok: doc?.tiktok ?? [],
    };
  }

  async saveFacebookPages(
    workspaceId: string,
    userId: string,
    pages: FacebookPageInput[],
  ): Promise<ConnectedAccountsDocument> {
    const key = this.encryptionKey();
    let doc = await this.connectedAccountsModel.findOne({ workspaceId }).exec();
    if (!doc) {
      doc = new this.connectedAccountsModel({
        userId,
        workspaceId,
        facebook: [],
        instagram: [],
        linkedin: [],
        tiktok: [],
      });
    }

    const now = new Date();
    for (const page of pages) {
      const encryptedAccessToken = encryptSecret(page.accessToken, key);
      const existing = doc.facebook.find((item) => item.accountId === page.accountId);
      if (existing) {
        existing.name = page.name;
        existing.username = page.username ?? null;
        existing.profileImageUrl = page.profileImageUrl ?? null;
        existing.category = page.category ?? null;
        existing.encryptedAccessToken = encryptedAccessToken;
        existing.tasks = page.tasks;
        existing.permissions = page.permissions;
        existing.authorizedByFacebookUserId = page.authorizedByFacebookUserId;
        existing.connectedByUserId = page.connectedByUserId;
        existing.status = 'connected';
        existing.lastSyncedAt = now;
        existing.disconnectedAt = null;
        existing.lastError = null;
        continue;
      }

      doc.facebook.push({
        accountId: page.accountId,
        accountType: 'page',
        name: page.name,
        username: page.username ?? null,
        profileImageUrl: page.profileImageUrl ?? null,
        category: page.category ?? null,
        authorizedByFacebookUserId: page.authorizedByFacebookUserId,
        encryptedAccessToken,
        tokenExpiresAt: null,
        permissions: page.permissions,
        tasks: page.tasks,
        connectedByUserId: page.connectedByUserId,
        status: 'connected',
        isDefault: !doc.facebook.some((item) => item.isDefault && item.status === 'connected'),
        connectedAt: now,
        lastSyncedAt: now,
        disconnectedAt: null,
        lastError: null,
      });
    }

    await doc.save();
    return doc;
  }

  async getFacebookPageForPublish(
    workspaceId: string,
    pageSubdocumentId: string,
  ): Promise<{
    connectedAccountId: string;
    pageId: string;
    pageName: string;
    accessToken: string;
  } | null> {
    const doc = await this.findByWorkspace(workspaceId);
    const page = doc?.facebook.find((item) => String(item._id) === pageSubdocumentId);
    if (!page?.encryptedAccessToken) {
      return null;
    }
    if (page.status !== 'connected' && page.status !== 'expiring') {
      return null;
    }
    try {
      return {
        connectedAccountId: String(page._id),
        pageId: page.accountId,
        pageName: page.name,
        accessToken: decryptSecret(page.encryptedAccessToken, this.encryptionKey()),
      };
    } catch {
      return null;
    }
  }

  async disconnectFacebookPage(workspaceId: string, pageSubdocumentId: string): Promise<void> {
    const doc = await this.connectedAccountsModel.findOne({ workspaceId }).exec();
    const page = doc?.facebook.find((item) => String(item._id) === pageSubdocumentId);
    if (!doc || !page) {
      throw new NotFoundException('Facebook Page was not found in this workspace');
    }
    page.status = 'disconnected';
    page.disconnectedAt = new Date();
    page.encryptedAccessToken = null;
    page.isDefault = false;
    await doc.save();
  }

  private encryptionKey(): string {
    const key = this.configService.get<string>('TOKEN_ENCRYPTION_KEY')?.trim();
    if (!key) {
      throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
    }
    return key;
  }
}
