import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { UsersService } from '../users/users.service';
import { CloudinaryService, UploadableFile } from './cloudinary.service';
import { FacebookGraphError, FacebookPublishService } from './facebook-publish.service';
import { isRetryablePublishError, PostScheduleService } from './post-schedule.service';
import { FacebookPostType, Post, PostDocument, PostMedia, PostStatus } from './schemas/post.schema';

const CAPTION_LIMIT = 63206;
const COMMENT_LIMIT = 8000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

export type PublicPost = {
  id: string;
  caption: string;
  postType: FacebookPostType;
  status: PostStatus;
  videoTitle: string | null;
  aiGenerated: boolean | null;
  firstComment: string | null;
  scheduledAt: Date | null;
  scheduleTimezone: string | null;
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
  private readonly logger = new Logger(PostsService.name);

  constructor(
    @InjectModel(Post.name)
    private readonly postModel: Model<PostDocument>,
    private readonly usersService: UsersService,
    private readonly connectedAccountsService: ConnectedAccountsService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly facebookPublishService: FacebookPublishService,
    @Inject(forwardRef(() => PostScheduleService))
    private readonly postScheduleService: PostScheduleService,
  ) {}

  async listDrafts(userId: string): Promise<PublicPost[]> {
    const workspaceId = await this.workspaceId(userId);
    const docs = await this.postModel.find({ workspaceId, status: 'draft' }).sort({ updatedAt: -1 }).exec();
    return docs.map((doc) => this.toPublic(doc));
  }

  async getDraft(userId: string, postId: string): Promise<PublicPost> {
    const doc = await this.requireDraft(userId, postId);
    return this.toPublic(doc);
  }

  async deleteDraft(userId: string, postId: string): Promise<void> {
    const doc = await this.requireDraft(userId, postId);
    await doc.deleteOne();
  }

  async saveDraft(input: {
    userId: string;
    draftId?: string;
    caption: string;
    pageIds: string[];
    files: UploadableFile[];
    keepPublicIds?: string[];
    postType: FacebookPostType;
    videoTitle?: string;
    aiGenerated?: boolean | null;
    firstComment?: string;
  }): Promise<PublicPost> {
    const caption = input.caption ?? '';
    const firstComment = input.firstComment?.trim() || '';
    if (Array.from(caption).length > CAPTION_LIMIT) {
      throw new BadRequestException('Facebook text is over 63,206 characters.');
    }
    if (Array.from(firstComment).length > COMMENT_LIMIT) {
      throw new BadRequestException('A Facebook comment is limited to 8,000 characters.');
    }
    this.assertContent(input.postType, caption, input.files, input.keepPublicIds?.length ?? 0);
    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) {
      throw new BadRequestException('Connect a Facebook Page before saving a draft.');
    }
    const targets = await this.targetsFor(membership.workspaceId, input.pageIds);
    const uploaded = await this.uploadFiles(input.files);
    const existing = input.draftId ? await this.requireDraft(input.userId, input.draftId) : null;
    const kept = (existing?.media ?? []).filter((item) => input.keepPublicIds?.includes(item.publicId));
    const media = [...kept, ...uploaded];
    this.assertStored(input.postType, input.caption ?? '', media);
    const fields = {
      caption: input.caption ?? '',
      firstComment: input.firstComment?.trim() || null,
      videoTitle: input.videoTitle?.trim() || null,
      aiGenerated: input.aiGenerated ?? null,
      postType: input.postType,
      status: 'draft' as const,
      media,
      facebook: targets.map((target) => ({
        connectedAccountId: target.connectedAccountId,
        pageId: target.pageId,
        pageName: target.pageName,
        facebookPostId: null,
        status: 'pending' as const,
        publishedAt: null,
        error: null,
        firstCommentId: null,
        firstCommentError: null,
      })),
      completedAt: null,
    };
    if (existing) {
      existing.set(fields);
      await existing.save();
      return this.toPublic(existing);
    }
    const doc = await this.postModel.create({
      userId: user.id,
      workspaceId: membership.workspaceId,
      instagram: [],
      linkedin: [],
      tiktok: [],
      ...fields,
    });
    return this.toPublic(doc);
  }

  async publishFeed(input: {
    userId: string;
    caption: string;
    pageIds: string[];
    files: UploadableFile[];
    keepPublicIds?: string[];
    draftId?: string;
    postType?: FacebookPostType;
    videoTitle?: string;
    aiGenerated?: boolean | null;
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

    const postType = input.postType ?? 'feed';
    const files = input.files ?? [];
    const existing = input.draftId ? await this.requireDraft(input.userId, input.draftId) : null;
    const kept = (existing?.media ?? []).filter((item) => input.keepPublicIds?.includes(item.publicId));
    this.assertContent(postType, caption, files, kept.length);

    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) {
      throw new BadRequestException('Connect a Facebook Page before publishing.');
    }

    const targets = await this.targetsFor(membership.workspaceId, pageIds);

    const commentTargets = new Set(
      (input.commentPageIds?.length ? input.commentPageIds : pageIds).map((id) => id.trim()),
    );

    const media = [...kept, ...(await this.uploadFiles(files))];
    this.assertStored(postType, caption, media);
    const videoTitle = input.videoTitle?.trim() || null;
    const aiGenerated = input.aiGenerated ?? null;

    const doc =
      existing ??
      (await this.postModel.create({
        userId: user.id,
        workspaceId: membership.workspaceId,
        instagram: [],
        linkedin: [],
        tiktok: [],
        caption,
        firstComment: firstComment || null,
        videoTitle,
        aiGenerated,
        postType,
        status: 'publishing',
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
        completedAt: null,
      }));
    if (existing) {
      existing.caption = caption;
      existing.firstComment = firstComment || null;
      existing.videoTitle = videoTitle;
      existing.aiGenerated = aiGenerated;
      existing.postType = postType;
      existing.status = 'publishing';
      existing.media = media;
      existing.facebook = targets.map((target) => ({
        connectedAccountId: target.connectedAccountId,
        pageId: target.pageId,
        pageName: target.pageName,
        facebookPostId: null,
        status: 'pending',
        publishedAt: null,
        error: null,
        firstCommentId: null,
        firstCommentError: null,
      }));
      await existing.save();
    }

    for (const target of targets) {
      const entry = doc.facebook.find((item) => item.connectedAccountId === target.connectedAccountId);
      if (!entry) {
        continue;
      }
      try {
        entry.facebookPostId = await this.facebookPublishService.publish({
          pageId: target.pageId,
          accessToken: target.accessToken,
          caption,
          media,
          postType,
          videoTitle: postType === 'feed' || postType === 'reel' ? videoTitle : null,
          aiGenerated: postType === 'reel' || postType === 'story' ? aiGenerated : null,
        });
        entry.status = 'published';
        entry.publishedAt = new Date();
        entry.error = null;
        if ((postType === 'feed' || postType === 'carousel') && firstComment && commentTargets.has(target.connectedAccountId)) {
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

    const failed = doc.facebook.filter((item) => item.status === 'failed').length;
    if (failed === doc.facebook.length) {
      doc.status = 'draft';
      doc.completedAt = null;
    } else {
      doc.status = failed === 0 ? 'published' : 'partially_failed';
      doc.completedAt = new Date();
    }
    await doc.save();
    return this.toPublic(doc);
  }

  async schedule(input: {
    userId: string;
    caption: string;
    pageIds: string[];
    files: UploadableFile[];
    keepPublicIds?: string[];
    draftId?: string;
    postType?: FacebookPostType;
    videoTitle?: string;
    aiGenerated?: boolean | null;
    firstComment?: string;
    commentPageIds?: string[];
    scheduledAt: string;
    timezone?: string;
  }): Promise<PublicPost> {
    const when = new Date(input.scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      throw new BadRequestException('Pick a time in the future.');
    }
    const prepared = await this.prepare(input);
    const doc = await this.savePrepared(prepared, {
      status: 'scheduled',
      scheduledAt: when,
      scheduleTimezone: input.timezone?.trim() || null,
      queueJobId: null,
      completedAt: null,
    });
    try {
      await this.postScheduleService.enqueue(doc.id, when, true);
      doc.queueJobId = `publish-${doc.id}`;
      await doc.save();
    } catch (err) {
      this.logger.warn(err instanceof Error ? err.message : 'Could not enqueue the scheduled post');
      doc.status = 'draft';
      doc.scheduledAt = null;
      doc.queueJobId = null;
      await doc.save();
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Could not schedule that post. Please try again.');
    }
    return this.toPublic(doc);
  }

  async reschedule(userId: string, postId: string, scheduledAt: string, timezone?: string): Promise<PublicPost> {
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      throw new BadRequestException('Pick a time in the future.');
    }
    const doc = await this.requireStatus(userId, postId, 'scheduled');
    doc.scheduledAt = when;
    doc.scheduleTimezone = timezone?.trim() || doc.scheduleTimezone || null;
    await this.postScheduleService.enqueue(doc.id, when, true);
    doc.queueJobId = `publish-${doc.id}`;
    await doc.save();
    return this.toPublic(doc);
  }

  async cancelSchedule(userId: string, postId: string): Promise<PublicPost> {
    const doc = await this.requireStatus(userId, postId, 'scheduled');
    await this.postScheduleService.remove(postId);
    doc.status = 'draft';
    doc.scheduledAt = null;
    doc.queueJobId = null;
    await doc.save();
    return this.toPublic(doc);
  }

  async publishDue(postId: string, _attemptsMade: number): Promise<void> {
    const current = await this.postModel.findById(postId).exec();
    if (!current || current.status === 'published' || current.status === 'canceled' || current.status === 'draft') return;

    let doc = current;
    if (current.status === 'scheduled') {
      const claimed = await this.postModel
        .findOneAndUpdate(
          { _id: postId, status: 'scheduled' },
          { $set: { status: 'publishing', lastPublishAttemptAt: new Date() }, $inc: { publishAttempts: 1 } },
          { new: true },
        )
        .exec();
      if (!claimed) return;
      doc = claimed;
    } else if (current.status === 'publishing') {
      doc.lastPublishAttemptAt = new Date();
      doc.publishAttempts += 1;
      await doc.save();
    } else {
      return;
    }

    const commentTargets = new Set(doc.commentPageIds?.length ? doc.commentPageIds : doc.facebook.map((item) => item.connectedAccountId));
    let retry = false;
    for (const entry of doc.facebook) {
      if (entry.status === 'published') continue;
      const page = await this.connectedAccountsService.getFacebookPageForPublish(doc.workspaceId, entry.connectedAccountId);
      if (!page) {
        entry.status = 'failed';
        entry.error = 'This Facebook Page is no longer connected.';
        continue;
      }
      try {
        entry.facebookPostId = await this.facebookPublishService.publish({
          pageId: page.pageId,
          accessToken: page.accessToken,
          caption: doc.caption,
          media: doc.media,
          postType: doc.postType,
          videoTitle: doc.postType === 'feed' || doc.postType === 'reel' ? doc.videoTitle : null,
          aiGenerated: doc.postType === 'reel' || doc.postType === 'story' ? doc.aiGenerated : null,
        });
        entry.status = 'published';
        entry.publishedAt = new Date();
        entry.error = null;
        if ((doc.postType === 'feed' || doc.postType === 'carousel') && doc.firstComment && commentTargets.has(entry.connectedAccountId) && !entry.firstCommentId) {
          try {
            entry.firstCommentId = await this.facebookPublishService.publishComment({
              pageId: page.pageId,
              postId: entry.facebookPostId,
              accessToken: page.accessToken,
              message: doc.firstComment,
            });
            entry.firstCommentError = null;
          } catch (commentError) {
            entry.firstCommentError = commentError instanceof Error ? commentError.message : 'Facebook did not post the comment';
          }
        }
      } catch (err) {
        if (isRetryablePublishError(err)) {
          entry.status = 'pending';
          entry.error = err instanceof Error ? err.message : 'Facebook did not publish the post';
          retry = true;
        } else {
          entry.status = 'failed';
          entry.error = err instanceof Error ? err.message : 'Facebook did not publish the post';
        }
      }
      doc.markModified('facebook');
      await doc.save();
    }

    if (retry) throw new Error('Facebook did not accept the post yet. It will be tried again.');
    this.finishPublishStatus(doc);
    await doc.save();
  }

  async finishFailedSchedule(postId: string): Promise<void> {
    const doc = await this.postModel.findById(postId).exec();
    if (!doc || doc.status !== 'publishing') return;
    for (const entry of doc.facebook) {
      if (entry.status === 'pending') {
        entry.status = 'failed';
        entry.error = entry.error || 'Facebook did not publish the post.';
      }
    }
    this.finishPublishStatus(doc);
    doc.markModified('facebook');
    await doc.save();
  }

  private async prepare(input: {
    userId: string;
    caption: string;
    pageIds: string[];
    files: UploadableFile[];
    keepPublicIds?: string[];
    draftId?: string;
    postType?: FacebookPostType;
    videoTitle?: string;
    aiGenerated?: boolean | null;
    firstComment?: string;
    commentPageIds?: string[];
  }) {
    const caption = input.caption ?? '';
    const firstComment = input.firstComment?.trim() || '';
    if (Array.from(caption).length > CAPTION_LIMIT) {
      throw new BadRequestException('Facebook text is over 63,206 characters.');
    }
    if (Array.from(firstComment).length > COMMENT_LIMIT) {
      throw new BadRequestException('A Facebook comment is limited to 8,000 characters.');
    }
    const pageIds = [...new Set(input.pageIds.map((id) => id.trim()).filter(Boolean))];
    if (pageIds.length === 0) throw new BadRequestException('Select at least one connected Facebook Page.');
    const postType = input.postType ?? 'feed';
    const files = input.files ?? [];
    const existing = input.draftId ? await this.requireDraft(input.userId, input.draftId) : null;
    const kept = (existing?.media ?? []).filter((item) => input.keepPublicIds?.includes(item.publicId));
    this.assertContent(postType, caption, files, kept.length);
    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) throw new BadRequestException('Connect a Facebook Page before publishing.');
    const targets = await this.targetsFor(membership.workspaceId, pageIds);
    const media = [...kept, ...(await this.uploadFiles(files))];
    this.assertStored(postType, caption, media);
    const allowComment = postType === 'feed' || postType === 'carousel';
    return {
      existing,
      userId: user.id,
      workspaceId: membership.workspaceId,
      caption,
      firstComment: allowComment ? firstComment || null : null,
      commentPageIds: allowComment ? (input.commentPageIds?.length ? input.commentPageIds : pageIds) : [],
      videoTitle: input.videoTitle?.trim() || null,
      aiGenerated: input.aiGenerated ?? null,
      postType,
      media,
      targets,
    };
  }

  private async savePrepared(
    prepared: Awaited<ReturnType<PostsService['prepare']>>,
    extra: { status: PostStatus; scheduledAt: Date | null; scheduleTimezone: string | null; queueJobId: string | null; completedAt: Date | null },
  ) {
    const facebook = prepared.targets.map((target) => ({
      connectedAccountId: target.connectedAccountId,
      pageId: target.pageId,
      pageName: target.pageName,
      facebookPostId: null,
      status: 'pending' as const,
      publishedAt: null,
      error: null,
      firstCommentId: null,
      firstCommentError: null,
    }));
    const fields = {
      caption: prepared.caption,
      firstComment: prepared.firstComment,
      commentPageIds: prepared.commentPageIds,
      videoTitle: prepared.videoTitle,
      aiGenerated: prepared.aiGenerated,
      postType: prepared.postType,
      media: prepared.media,
      facebook,
      ...extra,
    };
    if (prepared.existing) {
      prepared.existing.set(fields);
      await prepared.existing.save();
      return prepared.existing;
    }
    return this.postModel.create({
      userId: prepared.userId,
      workspaceId: prepared.workspaceId,
      instagram: [],
      linkedin: [],
      tiktok: [],
      publishAttempts: 0,
      ...fields,
    });
  }

  private finishPublishStatus(doc: PostDocument) {
    const failed = doc.facebook.filter((item) => item.status === 'failed').length;
    const published = doc.facebook.filter((item) => item.status === 'published').length;
    doc.status = published === 0 ? 'failed' : failed > 0 ? 'partially_failed' : 'published';
    doc.completedAt = new Date();
  }

  private async requireStatus(userId: string, postId: string, status: PostStatus): Promise<PostDocument> {
    const workspaceId = await this.workspaceId(userId);
    const doc = await this.postModel.findOne({ _id: postId, workspaceId, status }).exec();
    if (!doc) throw new NotFoundException('Scheduled post was not found');
    return doc;
  }

  private async workspaceId(userId: string): Promise<string> {
    const user = await this.usersService.findById(userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!membership) throw new BadRequestException('Connect a Facebook Page first.');
    return membership.workspaceId;
  }

  private async requireDraft(userId: string, postId: string): Promise<PostDocument> {
    const workspaceId = await this.workspaceId(userId);
    const doc = await this.postModel.findOne({ _id: postId, workspaceId, status: 'draft' }).exec();
    if (!doc) throw new NotFoundException('Draft was not found');
    return doc;
  }

  private async targetsFor(workspaceId: string, pageIds: string[]) {
    const targets: Array<{
      connectedAccountId: string;
      pageId: string;
      pageName: string;
      accessToken: string;
    }> = [];
    for (const pageId of [...new Set(pageIds.map((id) => id.trim()).filter(Boolean))]) {
      const page = await this.connectedAccountsService.getFacebookPageForPublish(workspaceId, pageId);
      if (!page) {
        throw new BadRequestException(
          'One of the selected Facebook Pages is not connected. Reconnect it from Accounts.',
        );
      }
      targets.push(page);
    }
    return targets;
  }

  private async uploadFiles(files: UploadableFile[]): Promise<PostMedia[]> {
    const media: PostMedia[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.mimetype) && !VIDEO_TYPES.has(file.mimetype)) {
        throw new BadRequestException('Use a JPEG, PNG, WebP, GIF, MP4, MOV, or WebM file.');
      }
      media.push(await this.cloudinaryService.upload(file));
    }
    return media;
  }

  private assertStored(postType: FacebookPostType, caption: string, media: PostMedia[]) {
    if (postType === 'feed') {
      const images = media.filter((item) => item.resourceType === 'image');
      const videos = media.filter((item) => item.resourceType === 'video');
      if (!caption.trim() && media.length === 0) {
        throw new BadRequestException('Facebook posts need text, an image, or a video.');
      }
      if (videos.length > 1) throw new BadRequestException('A Facebook Feed post can include one video.');
      if (videos.length > 0 && images.length > 0) {
        throw new BadRequestException('A Facebook Feed post can include images or one video, not both.');
      }
      if (images.length > 10) throw new BadRequestException('A Facebook Feed post can include up to 10 images.');
    }
    if (postType === 'carousel' && (media.length < 2 || media.length > 10 || media.some((item) => item.resourceType !== 'image'))) {
      throw new BadRequestException('A Facebook carousel needs 2 to 10 images.');
    }
    if (postType === 'reel') {
      if (media.length !== 1 || media[0].resourceType !== 'video' || media[0].format !== 'mp4') {
        throw new BadRequestException('A Facebook Reel needs one MP4 video.');
      }
      const item = media[0];
      if (item.duration != null && (item.duration < 3 || item.duration > 90)) {
        throw new BadRequestException('A Facebook Reel must be between 3 and 90 seconds.');
      }
      if (item.width != null && item.height != null && (item.width < 540 || item.height < 960)) {
        throw new BadRequestException('A Facebook Reel must be at least 540 × 960 pixels.');
      }
    }
    if (postType === 'story') {
      if (media.length !== 1) throw new BadRequestException('A Facebook Story needs one image or one video.');
      const item = media[0];
      if (item.resourceType === 'image' && (item.format === 'webp' || (item.bytes ?? 0) > 10 * 1024 * 1024)) {
        throw new BadRequestException('Facebook Story images need to be a JPEG, PNG, or GIF under 10 MB.');
      }
      if (item.resourceType === 'video' && item.format && item.format !== 'mp4') {
        throw new BadRequestException('A Facebook Story video needs to be an MP4.');
      }
    }
  }

  private assertContent(postType: FacebookPostType, caption: string, files: UploadableFile[], kept: number) {
    const images = files.filter((file) => IMAGE_TYPES.has(file.mimetype));
    const videos = files.filter((file) => VIDEO_TYPES.has(file.mimetype));
    if (images.length + videos.length !== files.length) {
      throw new BadRequestException('Use a JPEG, PNG, WebP, GIF, MP4, MOV, or WebM file.');
    }
    const total = files.length + kept;
    if (postType === 'feed') {
      if (!caption.trim() && total === 0) {
        throw new BadRequestException('Facebook posts need text, an image, or a video.');
      }
      if (videos.length > 1) throw new BadRequestException('A Facebook Feed post can include one video.');
      if (videos.length > 0 && (images.length > 0 || kept > 0)) {
        throw new BadRequestException('A Facebook Feed post can include images or one video, not both.');
      }
      if (images.length + kept > 10) throw new BadRequestException('A Facebook Feed post can include up to 10 images.');
      return;
    }
    if (postType === 'carousel') {
      if (videos.length > 0) throw new BadRequestException('A Facebook carousel is images only.');
      if (images.length + kept < 2 || images.length + kept > 10) {
        throw new BadRequestException('A Facebook carousel needs 2 to 10 images.');
      }
      return;
    }
    if (postType === 'reel') {
      if (total !== 1 || images.length > 0 || videos.length !== (kept ? 0 : 1)) {
        throw new BadRequestException('A Facebook Reel needs one MP4 video.');
      }
      if (videos.some((file) => file.mimetype !== 'video/mp4')) {
        throw new BadRequestException('A Facebook Reel needs an MP4 video.');
      }
      return;
    }
    if (total !== 1 || videos.length + images.length + (kept ? 1 : 0) < 1) {
      throw new BadRequestException('A Facebook Story needs one image or one video.');
    }
    if (images.length === 1 && images[0].size > 10 * 1024 * 1024) {
      throw new BadRequestException('A Facebook Story image must be 10 MB or smaller.');
    }
    if (images.some((file) => file.mimetype === 'image/webp')) {
      throw new BadRequestException('Facebook Stories accept JPEG, PNG, or GIF images.');
    }
    if (videos.some((file) => file.mimetype !== 'video/mp4')) {
      throw new BadRequestException('A Facebook Story video needs to be an MP4.');
    }
  }

  private toPublic(doc: PostDocument): PublicPost {
    return {
      id: doc.id,
      caption: doc.caption,
      postType: doc.postType ?? 'feed',
      status: doc.status ?? (doc.completedAt ? 'published' : 'draft'),
      videoTitle: doc.videoTitle ?? null,
      aiGenerated: doc.aiGenerated ?? null,
      firstComment: doc.firstComment ?? null,
      scheduledAt: doc.scheduledAt ?? null,
      scheduleTimezone: doc.scheduleTimezone ?? null,
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
