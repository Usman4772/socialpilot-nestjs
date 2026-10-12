import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { UsersService } from '../users/users.service';
import { CloudinaryService, UploadableFile } from './cloudinary.service';
import { FacebookGraphError, FacebookPublishService } from './facebook-publish.service';
import { Post, PostDocument, PostMedia } from './schemas/post.schema';

const CAPTION_LIMIT = 63206;
const COMMENT_LIMIT = 8000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export type PublicPost = {
  id: string;
  caption: string;
  postType: 'feed';
  media: PostMedia[];
  facebook: Array<{
    connectedAccountId: string;
    pageId: string;
    pageName: string;
    facebookPostId: string | null;
    status: 'pending' | 'published' | 'failed';
    publishedAt: Date | null;
    error: string | null;
    firstCommentId: string | null;
    firstCommentError: string | null;
  }>;
  createdAt: Date;
  completedAt: Date | null;
};

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Post.name)
    private readonly postModel: Model<PostDocument>,
    private readonly usersService: UsersService,
    private readonly connectedAccountsService: ConnectedAccountsService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly facebookPublishService: FacebookPublishService,
  ) {}

  async publishFeed(input: {
    userId: string;
    caption: string;
    pageIds: string[];
    files: UploadableFile[];
    firstComment?: string;
    commentPageIds?: string[];
  }): Promise<PublicPost> {
    const caption = input.caption ?? '';
    const firstComment = input.firstComment?.trim() || '';
    if (Array.from(caption).length > CAPTION_LIMIT) {
      throw new BadRequestException('Facebook text is over 63,206 characters.');
    }
    if (Array.from(firstComment).length > COMMENT_LIMIT) {
      throw new BadRequestException('A Facebook comment is limited to 8,000 characters.');
    }

    const pageIds = [...new Set(input.pageIds.map((id) => id.trim()).filter(Boolean))];
    if (pageIds.length === 0) {
      throw new BadRequestException('Select at least one connected Facebook Page.');
    }

    const files = input.files ?? [];
    this.assertMedia(caption, files);

    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) {
      throw new BadRequestException('Connect a Facebook Page before publishing.');
    }

    const targets: Array<{
      connectedAccountId: string;
      pageId: string;
      pageName: string;
      accessToken: string;
    }> = [];
    for (const pageId of pageIds) {
      const page = await this.connectedAccountsService.getFacebookPageForPublish(
        membership.workspaceId,
        pageId,
      );
      if (!page) {
        throw new BadRequestException(
          'One of the selected Facebook Pages is not connected. Reconnect it from Accounts.',
        );
      }
      targets.push(page);
    }

    const commentTargets = new Set(
      (input.commentPageIds?.length ? input.commentPageIds : pageIds).map((id) => id.trim()),
    );

    const media: PostMedia[] = [];
    for (const file of files) {
      media.push(await this.cloudinaryService.upload(file));
    }

    const doc = await this.postModel.create({
      userId: user.id,
      workspaceId: membership.workspaceId,
      caption,
      firstComment: firstComment || null,
      postType: 'feed',
      media,
      facebook: targets.map((target) => ({
        connectedAccountId: target.connectedAccountId,
        pageId: target.pageId,
        pageName: target.pageName,
        facebookPostId: null,
        status: 'pending',
        publishedAt: null,
        error: null,
        firstCommentId: null,
        firstCommentError: null,
      })),
      instagram: [],
      linkedin: [],
      tiktok: [],
      completedAt: null,
    });

    for (const target of targets) {
      const entry = doc.facebook.find((item) => item.connectedAccountId === target.connectedAccountId);
      if (!entry) {
        continue;
      }
      try {
        entry.facebookPostId = await this.facebookPublishService.publishFeed({
          pageId: target.pageId,
          accessToken: target.accessToken,
          caption,
          media,
        });
        entry.status = 'published';
        entry.publishedAt = new Date();
        entry.error = null;
        if (firstComment && commentTargets.has(target.connectedAccountId)) {
          try {
            entry.firstCommentId = await this.facebookPublishService.publishComment({
              pageId: target.pageId,
              postId: entry.facebookPostId,
              accessToken: target.accessToken,
              message: firstComment,
            });
            entry.firstCommentError = null;
          } catch (commentError) {
            const message =
              commentError instanceof Error ? commentError.message : 'Facebook did not post the comment';
            const missingPermission =
              commentError instanceof FacebookGraphError &&
              (commentError.code === 10 || commentError.code === 200 || commentError.code === 190);
            entry.firstCommentError = missingPermission
              ? `${message} Reconnect the Page from Accounts so Facebook grants comment access.`
              : message;
          }
        }
      } catch (err) {
        entry.status = 'failed';
        entry.error = err instanceof Error ? err.message : 'Facebook did not publish the post';
      }
      doc.markModified('facebook');
      await doc.save();
    }

    doc.completedAt = new Date();
    await doc.save();
    return this.toPublic(doc);
  }

  private assertMedia(caption: string, files: UploadableFile[]) {
    if (!caption.trim() && files.length === 0) {
      throw new BadRequestException('Facebook posts need text, an image, or a video.');
    }
    const images = files.filter((file) => IMAGE_TYPES.has(file.mimetype));
    const videos = files.filter((file) => VIDEO_TYPES.has(file.mimetype));
    if (images.length + videos.length !== files.length) {
      throw new BadRequestException('Use a JPEG, PNG, WebP, GIF, MP4, MOV, or WebM file.');
    }
    if (videos.length > 1) {
      throw new BadRequestException('A Facebook Feed post can include one video.');
    }
    if (videos.length > 0 && images.length > 0) {
      throw new BadRequestException('A Facebook Feed post can include images or one video, not both.');
    }
    if (images.length > 10) {
      throw new BadRequestException('A Facebook Feed post can include up to 10 images.');
    }
  }

  private toPublic(doc: PostDocument): PublicPost {
    return {
      id: doc.id,
      caption: doc.caption,
      postType: 'feed',
      media: doc.media,
      facebook: doc.facebook.map((item) => ({
        connectedAccountId: item.connectedAccountId,
        pageId: item.pageId,
        pageName: item.pageName,
        facebookPostId: item.facebookPostId ?? null,
        status: item.status,
        publishedAt: item.publishedAt ?? null,
        error: item.error ?? null,
        firstCommentId: item.firstCommentId ?? null,
        firstCommentError: item.firstCommentError ?? null,
      })),
      createdAt: doc.createdAt,
      completedAt: doc.completedAt ?? null,
    };
  }
}
