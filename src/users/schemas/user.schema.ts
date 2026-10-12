import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ _id: false })
export class UserWorkspaceMembership {
  @Prop({ required: true, trim: true })
  workspaceId: string;

  @Prop({ required: true, enum: ['owner', 'admin', 'editor', 'viewer'], default: 'owner' })
  role: 'owner' | 'admin' | 'editor' | 'viewer';

  @Prop({ required: true, enum: ['active', 'invited', 'suspended'], default: 'active' })
  status: 'active' | 'invited' | 'suspended';

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ type: Date, default: () => new Date() })
  joinedAt: Date;
}

const UserWorkspaceMembershipSchema = SchemaFactory.createForClass(UserWorkspaceMembership);

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, trim: true, unique: true })
  username: string;

  @Prop({ type: String, default: null, trim: true })
  firstName?: string | null;

  @Prop({ type: String, default: null, trim: true })
  lastName?: string | null;

  @Prop({ required: true, trim: true, lowercase: true, unique: true })
  email: string;

  /** Google OAuth subject (`sub`). */
  @Prop({ type: String, default: null, trim: true })
  googleId?: string | null;

  @Prop({ type: Boolean, default: true })
  emailVerified: boolean;

  /** Google profile photo URL. */
  @Prop({ type: String, default: null, trim: true })
  googlePictureUrl?: string | null;

  @Prop({ type: [UserWorkspaceMembershipSchema], default: [] })
  workspaces: UserWorkspaceMembership[];

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  createdAt: Date;

  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ 'workspaces.workspaceId': 1 });

UserSchema.index(
  { googleId: 1 },
  {
    unique: true,
    partialFilterExpression: { googleId: { $type: 'string' } },
  },
);
