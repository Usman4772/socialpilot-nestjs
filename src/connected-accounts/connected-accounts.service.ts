import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { decryptSecret, encryptSecret } from '../common/utils/token-cipher';
import {
  ConnectedAccounts,
  ConnectedAccountsDocument,
  FacebookPageAccount,
  InstagramAccount,
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

export type InstagramAccountInput = {
  accountId: string;
  name: string;
  username?: string | null;
  profileImageUrl?: string | null;
  facebookPageId: string;
};

export type InstagramLoginInput = {
  accountId: string;
  name: string;
  username?: string | null;
  profileImageUrl?: string | null;
  accessToken: string;
  tokenExpiresAt: Date | null;
};

export type PublicInstagramAccount = {
  id: string;
  accountId: string;
  name: string;
  username: string | null;
  profileImageUrl: string | null;
  loginMethod: 'facebook' | 'instagram';
  linkedFacebookPageId: string | null;
  linkedPageName: string | null;
  status: InstagramAccount['status'];
  isDefault: boolean;
  connectedAt: Date;
};

export type PublicConnectedAccounts = {
  workspaceId: string | null;
  facebook: PublicFacebookPage[];
  instagram: PublicInstagramAccount[];
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
      instagram: (doc?.instagram ?? [])
        .filter((account) => account.status !== 'disconnected')
        .map((account) => {
          const loginMethod = account.loginMethod === 'instagram' ? 'instagram' : 'facebook';
          return {
            id: String(account._id),
            accountId: account.accountId,
            name: account.name,
            username: account.username ?? null,
            profileImageUrl: account.profileImageUrl ?? null,
            loginMethod,
            linkedFacebookPageId: account.linkedFacebookPageId ?? null,
            linkedPageName:
              loginMethod === 'facebook'
                ? (doc?.facebook.find((page) => String(page._id) === account.linkedFacebookPageId)?.name ?? null)
                : null,
            status: account.status,
            isDefault: account.isDefault,
            connectedAt: account.connectedAt,
          };
        }),
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

  async saveInstagramAccounts(
    workspaceId: string,
    userId: string,
    accounts: InstagramAccountInput[],
    checkedFacebookPageIds: string[],
  ): Promise<number> {
    const doc = await this.connectedAccountsModel.findOne({ workspaceId }).exec();
    if (!doc) {
      return 0;
    }

    const now = new Date();
    const savedIds = new Set<string>();
    for (const account of accounts) {
      const page = doc.facebook.find(
        (item) => item.accountId === account.facebookPageId && item.status !== 'disconnected',
      );
      if (!page?._id) {
        continue;
      }
      const linkedFacebookPageId = String(page._id);
      const existing = doc.instagram.find((item) => item.accountId === account.accountId);
      if (existing) {
        existing.name = account.name;
        existing.username = account.username ?? null;
        existing.profileImageUrl = account.profileImageUrl ?? null;
        existing.linkedFacebookPageId = linkedFacebookPageId;
        existing.linkedFacebookAccountId = account.facebookPageId;
        if (existing.loginMethod !== 'instagram') {
          existing.loginMethod = 'facebook';
        }
        existing.connectedByUserId = userId;
        existing.status = 'connected';
        existing.lastSyncedAt = now;
        existing.disconnectedAt = null;
        savedIds.add(account.accountId);
        continue;
      }

      doc.instagram.push({
        accountId: account.accountId,
        accountType: 'professional',
        name: account.name,
        username: account.username ?? null,
        profileImageUrl: account.profileImageUrl ?? null,
        loginMethod: 'facebook',
        linkedFacebookPageId,
        linkedFacebookAccountId: account.facebookPageId,
        encryptedAccessToken: null,
        tokenExpiresAt: null,
        connectedByUserId: userId,
        status: 'connected',
        isDefault: !doc.instagram.some((item) => item.isDefault && item.status === 'connected'),
        connectedAt: now,
        lastSyncedAt: now,
        disconnectedAt: null,
      });
      savedIds.add(account.accountId);
    }

    const checked = new Set(checkedFacebookPageIds);
    for (const account of doc.instagram) {
      if (
        account.status === 'disconnected' ||
        account.loginMethod === 'instagram' ||
        !account.linkedFacebookAccountId ||
        !checked.has(account.linkedFacebookAccountId)
      ) {
        continue;
      }
      if (!savedIds.has(account.accountId)) {
        account.status = 'disconnected';
        account.disconnectedAt = now;
        account.isDefault = false;
      }
    }

    await doc.save();
    return savedIds.size;
  }

  async saveInstagramLoginAccount(workspaceId: string, userId: string, account: InstagramLoginInput): Promise<void> {
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
    const encryptedAccessToken = encryptSecret(account.accessToken, key);
    const existing = doc.instagram.find((item) => item.accountId === account.accountId);
    if (existing) {
      existing.name = account.name;
      existing.username = account.username ?? null;
      existing.profileImageUrl = account.profileImageUrl ?? null;
      existing.loginMethod = 'instagram';
      existing.encryptedAccessToken = encryptedAccessToken;
      existing.tokenExpiresAt = account.tokenExpiresAt;
      existing.connectedByUserId = userId;
      existing.status = 'connected';
      existing.lastSyncedAt = now;
      existing.disconnectedAt = null;
      await doc.save();
      return;
    }

    doc.instagram.push({
      accountId: account.accountId,
      accountType: 'professional',
      name: account.name,
      username: account.username ?? null,
      profileImageUrl: account.profileImageUrl ?? null,
      loginMethod: 'instagram',
      linkedFacebookPageId: null,
      linkedFacebookAccountId: null,
      encryptedAccessToken,
      tokenExpiresAt: account.tokenExpiresAt,
      connectedByUserId: userId,
      status: 'connected',
      isDefault: !doc.instagram.some((item) => item.isDefault && item.status === 'connected'),
      connectedAt: now,
      lastSyncedAt: now,
      disconnectedAt: null,
    });
    await doc.save();
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

  async getInstagramAccountForPublish(
    workspaceId: string,
    accountSubdocumentId: string,
  ): Promise<{
    connectedAccountId: string;
    accountId: string;
    name: string;
    username: string | null;
    accessToken: string;
    host: 'instagram' | 'facebook';
  } | null> {
    const doc = await this.findByWorkspace(workspaceId);
    const account = doc?.instagram.find((item) => String(item._id) === accountSubdocumentId);
    if (!account || (account.status !== 'connected' && account.status !== 'expiring')) {
      return null;
    }
    try {
      if (account.loginMethod === 'instagram') {
        if (!account.encryptedAccessToken) return null;
        if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= Date.now()) return null;
        return {
          connectedAccountId: String(account._id),
          accountId: account.accountId,
          name: account.name,
          username: account.username ?? null,
          accessToken: decryptSecret(account.encryptedAccessToken, this.encryptionKey()),
          host: 'instagram',
        };
      }
      const page = doc?.facebook.find((item) => String(item._id) === account.linkedFacebookPageId);
      if (!page?.encryptedAccessToken) return null;
      if (page.status !== 'connected' && page.status !== 'expiring') return null;
      return {
        connectedAccountId: String(account._id),
        accountId: account.accountId,
        name: account.name,
        username: account.username ?? null,
        accessToken: decryptSecret(page.encryptedAccessToken, this.encryptionKey()),
        host: 'facebook',
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
    for (const account of doc.instagram) {
      if (
        account.loginMethod !== 'instagram' &&
        account.linkedFacebookPageId === pageSubdocumentId &&
        account.status !== 'disconnected'
      ) {
        account.status = 'disconnected';
        account.disconnectedAt = page.disconnectedAt;
        account.isDefault = false;
        account.encryptedAccessToken = null;
      }
    }
    await doc.save();
  }

  async disconnectInstagramAccount(workspaceId: string, accountSubdocumentId: string): Promise<void> {
    const doc = await this.connectedAccountsModel.findOne({ workspaceId }).exec();
    const account = doc?.instagram.find((item) => String(item._id) === accountSubdocumentId);
    if (!doc || !account) {
      throw new NotFoundException('Instagram account was not found in this workspace');
    }
    account.status = 'disconnected';
    account.disconnectedAt = new Date();
    account.isDefault = false;
    account.encryptedAccessToken = null;
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
