import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const accountStatuses = [
  'connected',
  'expiring',
  'expired',
  'disconnected',
  'permission_missing',
  'error',
] as const;

export type AccountStatus = (typeof accountStatuses)[number];

@Schema({ _id: true, timestamps: false })
export class FacebookPageAccount {
  _id?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  accountId: string;

  @Prop({ required: true, default: 'page' })
  accountType: 'page';

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null })
  username?: string | null;

  @Prop({ type: String, default: null })
  profileImageUrl?: string | null;

  @Prop({ type: String, default: null })
  category?: string | null;

  @Prop({ type: String, default: null })
  authorizedByFacebookUserId?: string | null;

  @Prop({ type: String, default: null })
  encryptedAccessToken?: string | null;

  @Prop({ type: Date, default: null })
  tokenExpiresAt?: Date | null;

  @Prop({ type: [String], default: [] })
  permissions: string[];

  @Prop({ type: [String], default: [] })
  tasks: string[];

  @Prop({ required: true })
  connectedByUserId: string;

  @Prop({ required: true, enum: accountStatuses, default: 'connected' })
  status: AccountStatus;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ type: Date, default: () => new Date() })
  connectedAt: Date;

  @Prop({ type: Date, default: null })
  lastSyncedAt?: Date | null;

  @Prop({ type: Date, default: null })
  disconnectedAt?: Date | null;

  @Prop({
    type: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      occurredAt: { type: Date, default: null },
    },
    default: null,
  })
  lastError?: { code?: string | null; message?: string | null; occurredAt?: Date | null } | null;
}

export const FacebookPageAccountSchema = SchemaFactory.createForClass(FacebookPageAccount);

@Schema({ _id: true, timestamps: false })
export class InstagramAccount {
  _id?: Types.ObjectId;

  @Prop({ required: true, trim: true })
  accountId: string;

  @Prop({ required: true, default: 'professional' })
  accountType: 'professional';

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null })
  username?: string | null;

  @Prop({ type: String, default: null })
  profileImageUrl?: string | null;

  @Prop({ required: true, enum: ['facebook', 'instagram'], default: 'facebook' })
  loginMethod: 'facebook' | 'instagram';

  @Prop({ type: String, default: null })
  linkedFacebookPageId?: string | null;

  @Prop({ type: String, default: null })
  linkedFacebookAccountId?: string | null;

  @Prop({ type: String, default: null })
  encryptedAccessToken?: string | null;

  @Prop({ type: Date, default: null })
  tokenExpiresAt?: Date | null;

  @Prop({ required: true })
  connectedByUserId: string;

  @Prop({ required: true, enum: accountStatuses, default: 'connected' })
  status: AccountStatus;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ type: Date, default: () => new Date() })
  connectedAt: Date;

  @Prop({ type: Date, default: null })
  lastSyncedAt?: Date | null;

  @Prop({ type: Date, default: null })
  disconnectedAt?: Date | null;
}

export const InstagramAccountSchema = SchemaFactory.createForClass(InstagramAccount);

@Schema({ timestamps: true, collection: 'connected_accounts' })
export class ConnectedAccounts {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, unique: true })
  workspaceId: string;

  @Prop({ type: [FacebookPageAccountSchema], default: [] })
  facebook: FacebookPageAccount[];

  @Prop({ type: [InstagramAccountSchema], default: [] })
  instagram: InstagramAccount[];

  @Prop({ type: [Object], default: [] })
  linkedin: Record<string, unknown>[];

  @Prop({ type: [Object], default: [] })
  tiktok: Record<string, unknown>[];

  createdAt: Date;

  updatedAt: Date;
}

export type ConnectedAccountsDocument = HydratedDocument<ConnectedAccounts>;
export const ConnectedAccountsSchema = SchemaFactory.createForClass(ConnectedAccounts);

ConnectedAccountsSchema.index({ workspaceId: 1, 'facebook.accountId': 1 });
ConnectedAccountsSchema.index({ workspaceId: 1, 'instagram.accountId': 1 });
