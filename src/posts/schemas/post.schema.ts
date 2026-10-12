import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const postPublishStatuses = ['pending', 'published', 'failed'] as const;
export type PostPublishStatus = (typeof postPublishStatuses)[number];

@Schema({ _id: false })
export class PostMedia {
  @Prop({ required: true })
  publicId: string;

  @Prop({ required: true })
  secureUrl: string;

  @Prop({ required: true, enum: ['image', 'video'] })
  resourceType: 'image' | 'video';

  @Prop({ type: String, default: null })
  format?: string | null;

  @Prop({ type: Number, default: null })
  width?: number | null;

  @Prop({ type: Number, default: null })
  height?: number | null;

  @Prop({ type: Number, default: null })
  bytes?: number | null;
}

export const PostMediaSchema = SchemaFactory.createForClass(PostMedia);

@Schema({ _id: true })
export class FacebookPostTarget {
  _id?: Types.ObjectId;

  @Prop({ required: true })
  connectedAccountId: string;

  @Prop({ required: true })
  pageId: string;

  @Prop({ required: true })
  pageName: string;

  @Prop({ type: String, default: null })
  facebookPostId?: string | null;

  @Prop({ required: true, enum: postPublishStatuses, default: 'pending' })
  status: PostPublishStatus;

  @Prop({ type: Date, default: null })
  publishedAt?: Date | null;

  @Prop({ type: String, default: null })
  error?: string | null;

  @Prop({ type: String, default: null })
  firstCommentId?: string | null;

  @Prop({ type: String, default: null })
  firstCommentError?: string | null;
}

export const FacebookPostTargetSchema = SchemaFactory.createForClass(FacebookPostTarget);

@Schema({ timestamps: true, collection: 'posts' })
export class Post {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, index: true })
  workspaceId: string;

  @Prop({ required: true, default: '' })
  caption: string;

  @Prop({ type: String, default: null })
  firstComment?: string | null;

  @Prop({ required: true, default: 'feed' })
  postType: 'feed';

  @Prop({ type: [PostMediaSchema], default: [] })
  media: PostMedia[];

  @Prop({ type: [FacebookPostTargetSchema], default: [] })
  facebook: FacebookPostTarget[];

  @Prop({ type: [Object], default: [] })
  instagram: Record<string, unknown>[];

  @Prop({ type: [Object], default: [] })
  linkedin: Record<string, unknown>[];

  @Prop({ type: [Object], default: [] })
  tiktok: Record<string, unknown>[];

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  createdAt: Date;

  updatedAt: Date;
}

export type PostDocument = HydratedDocument<Post>;
export const PostSchema = SchemaFactory.createForClass(Post);

PostSchema.index({ workspaceId: 1, createdAt: -1 });
