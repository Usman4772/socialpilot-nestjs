import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { UsersService } from '../users/users.service';
import { CloudinaryService, UploadableFile } from './cloudinary.service';
import { FacebookGraphError, FacebookPublishService } from './facebook-publish.service';
import { InstagramGraphError, InstagramPublishService } from './instagram-publish.service';
import { LinkedInPublishError, LinkedInPublishService } from './linkedin-publish.service';
import { isRetryablePublishError, PostScheduleService } from './post-schedule.service';
import {
  FacebookPostType,
  InstagramAddOn,
  InstagramPostType,
  LinkedInPollDuration,
  LinkedInPostType,
  Post,
  PostDocument,
  PostMedia,
  PostStatus,
} from './schemas/post.schema';

type InstagramUserTagInput = { username: string; x: number | null; y: number | null };

type InstagramDetails = {
  userTags: InstagramUserTagInput[];
  collaborators: string[];
  addOn: InstagramAddOn;
  pollOptions: string[];
  pollOpenEnded: boolean;
};

type LinkedInFields = {
  linkedinAccountIds?: string[];
  linkedinPostType?: LinkedInPostType;
  linkedinCaption?: string;
  linkedinPollQuestion?: string;
  linkedinPollOptions?: string;
  linkedinPollDuration?: string;
  linkedinCarouselTitle?: string;
  linkedinPdf?: UploadableFile;
};

type LinkedInDetails = {
  pollQuestion: string;
  pollOptions: string[];
  pollDuration: LinkedInPollDuration;
  carouselTitle: string;
};

const EMPTY_INSTAGRAM_DETAILS: InstagramDetails = {
  userTags: [],
  collaborators: [],
  addOn: 'none',
  pollOptions: [],
  pollOpenEnded: false,
};

const CAPTION_LIMIT = 63206;
const LINKEDIN_CAPTION_LIMIT = 3000;
const INSTAGRAM_CAPTION_LIMIT = 2200;
const COMMENT_LIMIT = 8000;
const INSTAGRAM_COMMENT_LIMIT = 2200;
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
  instagram: Array<{
    connectedAccountId: string;
    accountId: string;
    name: string;
    username: string | null;
    postType: InstagramPostType;
    caption: string;
    userTags: InstagramUserTagInput[];
    collaborators: string[];
    addOn: InstagramAddOn;
    pollOptions: string[];
    pollOpenEnded: boolean;
    instagramMediaId: string | null;
    status: 'pending' | 'published' | 'failed';
    publishedAt: Date | null;
    error: string | null;
    firstCommentId: string | null;
    firstCommentError: string | null;
  }>;
  linkedin: Array<{
    connectedAccountId: string;
    accountId: string;
    name: string;
    postType: LinkedInPostType;
    caption: string;
    pollQuestion: string;
    pollOptions: string[];
    pollDuration: LinkedInPollDuration;
    carouselTitle: string;
    linkedinPostId: string | null;
    status: 'pending' | 'published' | 'failed';
    publishedAt: Date | null;
    error: string | null;
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
    private readonly instagramPublishService: InstagramPublishService,
    private readonly linkedInPublishService: LinkedInPublishService,
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
    instagramAccountIds?: string[];
    instagramPostType?: InstagramPostType;
    instagramCaption?: string;
    instagramUserTags?: string;
    instagramCollaborators?: string;
    instagramAddOn?: string;
    instagramPollOptions?: string;
    instagramPollOpenEnded?: boolean;
    linkedinAccountIds?: string[];
    linkedinPostType?: LinkedInPostType;
    linkedinCaption?: string;
    linkedinPollQuestion?: string;
    linkedinPollOptions?: string;
    linkedinPollDuration?: string;
    linkedinCarouselTitle?: string;
    linkedinPdf?: UploadableFile;
    files: UploadableFile[];
    keepPublicIds?: string[];
    postType: FacebookPostType;
    videoTitle?: string;
    aiGenerated?: boolean | null;
    firstComment?: string;
  }): Promise<PublicPost> {
    const caption = input.caption ?? '';
    const firstComment = input.firstComment?.trim() || '';
    const pageIds = this.uniqueIds(input.pageIds);
    const instagramAccountIds = this.uniqueIds(input.instagramAccountIds ?? []);
    const linkedinAccountIds = this.uniqueIds(input.linkedinAccountIds ?? []);
    if (pageIds.length === 0 && instagramAccountIds.length === 0 && linkedinAccountIds.length === 0) {
      throw new BadRequestException('Select at least one connected account.');
    }
    if (Array.from(caption).length > CAPTION_LIMIT) {
      throw new BadRequestException('Facebook text is over 63,206 characters.');
    }
    if (Array.from(firstComment).length > COMMENT_LIMIT) {
      throw new BadRequestException('A Facebook comment is limited to 8,000 characters.');
    }
    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) {
      throw new BadRequestException('Connect an account before saving a draft.');
    }
    const targets = pageIds.length > 0 ? await this.targetsFor(membership.workspaceId, pageIds) : [];
    const instagramTargets =
      instagramAccountIds.length > 0 ? await this.instagramTargetsFor(membership.workspaceId, instagramAccountIds) : [];
    const uploaded = await this.uploadFiles(input.files);
    const existing = input.draftId ? await this.requireDraft(input.userId, input.draftId) : null;
    const kept = (existing?.media ?? []).filter((item) => input.keepPublicIds?.includes(item.publicId));
    const linkedIn = await this.withLinkedIn(membership.workspaceId, input, caption, [...kept, ...uploaded]);
    const media = linkedIn.media;
    const visual = this.visualMedia(media);
    if (pageIds.length > 0) this.assertContent(input.postType, caption, input.files, kept.filter((item) => item.resourceType !== 'document').length);
    if (pageIds.length > 0) this.assertStored(input.postType, input.caption ?? '', visual);
    const instagramPostType = input.instagramPostType ?? 'feed';
    const instagramCaption = input.instagramCaption ?? caption;
    if (instagramTargets.length > 0) this.assertInstagram(instagramPostType, instagramCaption, visual);
    const instagramDetails =
      instagramTargets.length > 0
        ? this.instagramDetails(instagramPostType, instagramCaption, media, this.readInstagramExtras(input), instagramTargets.some((target) => target.host === 'facebook'))
        : EMPTY_INSTAGRAM_DETAILS;
    const fields = {
      caption: input.caption ?? '',
      firstComment: input.firstComment?.trim() || null,
      videoTitle: input.videoTitle?.trim() || null,
      aiGenerated: input.aiGenerated ?? null,
      postType: pageIds.length > 0 ? input.postType : instagramTargets.length > 0 ? instagramPostType : 'feed',
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
      instagram: this.instagramEntries(instagramTargets, instagramPostType, instagramCaption, instagramDetails),
      linkedin: linkedIn.entries,
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
    instagramAccountIds?: string[];
    instagramPostType?: InstagramPostType;
    instagramCaption?: string;
    instagramUserTags?: string;
    instagramCollaborators?: string;
    instagramAddOn?: string;
    instagramPollOptions?: string;
    instagramPollOpenEnded?: boolean;
    linkedinAccountIds?: string[];
    linkedinPostType?: LinkedInPostType;
    linkedinCaption?: string;
    linkedinPollQuestion?: string;
    linkedinPollOptions?: string;
    linkedinPollDuration?: string;
    linkedinCarouselTitle?: string;
    linkedinPdf?: UploadableFile;
  }): Promise<PublicPost> {
    const caption = input.caption ?? '';
    const firstComment = input.firstComment?.trim() || '';
    const pageIds = this.uniqueIds(input.pageIds);
    const instagramAccountIds = this.uniqueIds(input.instagramAccountIds ?? []);
    const linkedinAccountIds = this.uniqueIds(input.linkedinAccountIds ?? []);
    if (pageIds.length === 0 && instagramAccountIds.length === 0 && linkedinAccountIds.length === 0) {
      throw new BadRequestException('Select at least one connected account.');
    }
    if (Array.from(caption).length > CAPTION_LIMIT) {
      throw new BadRequestException('Facebook text is over 63,206 characters.');
    }
    if (Array.from(firstComment).length > COMMENT_LIMIT) {
      throw new BadRequestException('A Facebook comment is limited to 8,000 characters.');
    }

    const postType = input.postType ?? 'feed';
    const files = input.files ?? [];
    const existing = input.draftId ? await this.requireDraft(input.userId, input.draftId) : null;
    const kept = (existing?.media ?? []).filter((item) => input.keepPublicIds?.includes(item.publicId));
    if (pageIds.length > 0) this.assertContent(postType, caption, files, kept.filter((item) => item.resourceType !== 'document').length);

    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) {
      throw new BadRequestException('Connect an account before publishing.');
    }

    const targets = pageIds.length > 0 ? await this.targetsFor(membership.workspaceId, pageIds) : [];
    const instagramTargets =
      instagramAccountIds.length > 0 ? await this.instagramTargetsFor(membership.workspaceId, instagramAccountIds) : [];
    const instagramPostType = input.instagramPostType ?? 'feed';
    const instagramCaption = input.instagramCaption ?? caption;

    const commentTargets = new Set(
      this.commentAccountIds({
        pageIds,
        facebookPostType: postType,
        instagramAccountIds,
        instagramPostType,
        requested: input.commentPageIds ?? [],
        firstComment,
      }),
    );
    if ([...commentTargets].some((id) => instagramAccountIds.includes(id)) && Array.from(firstComment).length > INSTAGRAM_COMMENT_LIMIT) {
      throw new BadRequestException('An Instagram comment is limited to 2,200 characters.');
    }

    const linkedIn = await this.withLinkedIn(membership.workspaceId, input, caption, [...kept, ...(await this.uploadFiles(files))]);
    const media = linkedIn.media;
    const visual = this.visualMedia(media);
    if (pageIds.length > 0) this.assertStored(postType, caption, visual);
    if (instagramTargets.length > 0) this.assertInstagram(instagramPostType, instagramCaption, visual);
    const instagramDetails =
      instagramTargets.length > 0
        ? this.instagramDetails(instagramPostType, instagramCaption, media, this.readInstagramExtras(input), instagramTargets.some((target) => target.host === 'facebook'))
        : EMPTY_INSTAGRAM_DETAILS;
    const videoTitle = input.videoTitle?.trim() || null;
    const aiGenerated = input.aiGenerated ?? null;

    const doc =
      existing ??
      (await this.postModel.create({
        userId: user.id,
        workspaceId: membership.workspaceId,
        instagram: this.instagramEntries(instagramTargets, instagramPostType, instagramCaption, instagramDetails),
        linkedin: linkedIn.entries,
        tiktok: [],
        caption,
        firstComment: commentTargets.size > 0 ? firstComment || null : null,
        commentPageIds: [...commentTargets],
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
      existing.firstComment = commentTargets.size > 0 ? firstComment || null : null;
      existing.commentPageIds = [...commentTargets];
      existing.videoTitle = videoTitle;
      existing.aiGenerated = aiGenerated;
      existing.postType = pageIds.length > 0 ? postType : instagramTargets.length > 0 ? instagramPostType : 'feed';
      existing.status = 'publishing';
      existing.media = media;
      existing.linkedin = linkedIn.entries;
      existing.markModified('linkedin');
      existing.instagram = this.instagramEntries(instagramTargets, instagramPostType, instagramCaption, instagramDetails);
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

    await this.publishInstagramTargets(doc, false);
    await this.publishLinkedInTargets(doc, false);
    const entries = [...doc.facebook, ...doc.instagram, ...doc.linkedin];
    const failed = entries.filter((item) => item.status === 'failed').length;
    if (entries.length > 0 && failed === entries.length) {
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
    instagramAccountIds?: string[];
    instagramPostType?: InstagramPostType;
    instagramCaption?: string;
    instagramUserTags?: string;
    instagramCollaborators?: string;
    instagramAddOn?: string;
    instagramPollOptions?: string;
    instagramPollOpenEnded?: boolean;
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

    if (await this.publishInstagramTargets(doc, true)) retry = true;
    if (await this.publishLinkedInTargets(doc, true)) retry = true;
    if (retry) throw new Error('The post was not accepted yet. It will be tried again.');
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
    for (const entry of doc.instagram) {
      if (entry.status === 'pending') {
        entry.status = 'failed';
        entry.error = entry.error || 'Instagram did not publish the post.';
      }
    }
    for (const entry of doc.linkedin) {
      if (entry.status === 'pending') {
        entry.status = 'failed';
        entry.error = entry.error || 'LinkedIn did not publish the post.';
      }
    }
    this.finishPublishStatus(doc);
    doc.markModified('facebook');
    doc.markModified('instagram');
    doc.markModified('linkedin');
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
    instagramAccountIds?: string[];
    instagramPostType?: InstagramPostType;
    instagramCaption?: string;
    instagramUserTags?: string;
    instagramCollaborators?: string;
    instagramAddOn?: string;
    instagramPollOptions?: string;
    instagramPollOpenEnded?: boolean;
    linkedinAccountIds?: string[];
    linkedinPostType?: LinkedInPostType;
    linkedinCaption?: string;
    linkedinPollQuestion?: string;
    linkedinPollOptions?: string;
    linkedinPollDuration?: string;
    linkedinCarouselTitle?: string;
    linkedinPdf?: UploadableFile;
  }) {
    const caption = input.caption ?? '';
    const firstComment = input.firstComment?.trim() || '';
    const pageIds = this.uniqueIds(input.pageIds);
    const instagramAccountIds = this.uniqueIds(input.instagramAccountIds ?? []);
    const linkedinAccountIds = this.uniqueIds(input.linkedinAccountIds ?? []);
    if (pageIds.length === 0 && instagramAccountIds.length === 0 && linkedinAccountIds.length === 0) {
      throw new BadRequestException('Select at least one connected account.');
    }
    if (Array.from(caption).length > CAPTION_LIMIT) {
      throw new BadRequestException('Facebook text is over 63,206 characters.');
    }
    if (Array.from(firstComment).length > COMMENT_LIMIT) {
      throw new BadRequestException('A Facebook comment is limited to 8,000 characters.');
    }
    const postType = input.postType ?? 'feed';
    const files = input.files ?? [];
    const existing = input.draftId ? await this.requireDraft(input.userId, input.draftId) : null;
    const kept = (existing?.media ?? []).filter((item) => input.keepPublicIds?.includes(item.publicId));
    if (pageIds.length > 0) this.assertContent(postType, caption, files, kept.filter((item) => item.resourceType !== 'document').length);
    const user = await this.usersService.findById(input.userId);
    const membership = user?.workspaces?.find((item) => item.status === 'active');
    if (!user || !membership) throw new BadRequestException('Connect an account before publishing.');
    const targets = pageIds.length > 0 ? await this.targetsFor(membership.workspaceId, pageIds) : [];
    const instagramTargets =
      instagramAccountIds.length > 0 ? await this.instagramTargetsFor(membership.workspaceId, instagramAccountIds) : [];
    const linkedIn = await this.withLinkedIn(membership.workspaceId, input, caption, [...kept, ...(await this.uploadFiles(files))]);
    const media = linkedIn.media;
    const visual = this.visualMedia(media);
    if (pageIds.length > 0) this.assertStored(postType, caption, visual);
    const instagramPostType = input.instagramPostType ?? 'feed';
    const instagramCaption = input.instagramCaption ?? caption;
    if (instagramTargets.length > 0) this.assertInstagram(instagramPostType, instagramCaption, visual);
    const instagramDetails =
      instagramTargets.length > 0
        ? this.instagramDetails(instagramPostType, instagramCaption, media, this.readInstagramExtras(input), instagramTargets.some((target) => target.host === 'facebook'))
        : EMPTY_INSTAGRAM_DETAILS;
    const commentPageIds = this.commentAccountIds({
      pageIds,
      facebookPostType: postType,
      instagramAccountIds,
      instagramPostType,
      requested: input.commentPageIds ?? [],
      firstComment,
    });
    if (commentPageIds.some((id) => instagramAccountIds.includes(id)) && Array.from(firstComment).length > INSTAGRAM_COMMENT_LIMIT) {
      throw new BadRequestException('An Instagram comment is limited to 2,200 characters.');
    }
    return {
      existing,
      userId: user.id,
      workspaceId: membership.workspaceId,
      caption,
      firstComment: commentPageIds.length > 0 ? firstComment || null : null,
      commentPageIds,
      videoTitle: input.videoTitle?.trim() || null,
      aiGenerated: input.aiGenerated ?? null,
      postType: pageIds.length > 0 ? postType : instagramTargets.length > 0 ? instagramPostType : 'feed',
      media,
      targets,
      instagram: this.instagramEntries(instagramTargets, instagramPostType, instagramCaption, instagramDetails),
      linkedin: linkedIn.entries,
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
      instagram: prepared.instagram,
      linkedin: prepared.linkedin,
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
      tiktok: [],
      publishAttempts: 0,
      ...fields,
    });
  }

  private finishPublishStatus(doc: PostDocument) {
    const entries = [...doc.facebook, ...doc.instagram, ...doc.linkedin];
    const failed = entries.filter((item) => item.status === 'failed').length;
    const published = entries.filter((item) => item.status === 'published').length;
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

  private commentAccountIds(input: {
    pageIds: string[];
    facebookPostType: FacebookPostType;
    instagramAccountIds: string[];
    instagramPostType: InstagramPostType;
    requested: string[];
    firstComment: string;
  }): string[] {
    if (!input.firstComment.trim()) return [];
    const requested = new Set(this.uniqueIds(input.requested));
    const pick = (ids: string[]) => (requested.size === 0 ? ids : ids.filter((id) => requested.has(id)));
    const facebook =
      input.pageIds.length > 0 && (input.facebookPostType === 'feed' || input.facebookPostType === 'carousel')
        ? pick(input.pageIds)
        : [];
    const instagram =
      input.instagramAccountIds.length > 0 && (input.instagramPostType === 'feed' || input.instagramPostType === 'reel')
        ? pick(input.instagramAccountIds)
        : [];
    return [...facebook, ...instagram];
  }

  private uniqueIds(ids: string[]): string[] {
    return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  }

  private async instagramTargetsFor(workspaceId: string, accountIds: string[]) {
    const targets: Array<{
      connectedAccountId: string;
      accountId: string;
      name: string;
      username: string | null;
      host: 'instagram' | 'facebook';
    }> = [];
    for (const accountId of accountIds) {
      const account = await this.connectedAccountsService.getInstagramAccountForPublish(workspaceId, accountId);
      if (!account) {
        throw new BadRequestException('Reconnect the Instagram account from Accounts.');
      }
      targets.push(account);
    }
    return targets;
  }

  private instagramEntries(
    targets: Array<{ connectedAccountId: string; accountId: string; name: string; username: string | null; host: 'instagram' | 'facebook' }>,
    postType: InstagramPostType,
    caption: string,
    details: InstagramDetails,
  ) {
    return targets.map((target) => {
      const business = target.host === 'facebook' && postType !== 'story';
      return {
        connectedAccountId: target.connectedAccountId,
        accountId: target.accountId,
        name: target.name,
        username: target.username,
        postType,
        caption: postType === 'story' ? '' : caption,
        userTags: postType === 'story' ? [] : details.userTags,
        collaborators: business ? details.collaborators : [],
        addOn: business ? details.addOn : 'none',
        pollOptions: business && details.addOn === 'poll' ? details.pollOptions : [],
        pollOpenEnded: business && details.addOn === 'poll' ? details.pollOpenEnded : false,
        instagramMediaId: null,
        firstCommentId: null,
        firstCommentError: null,
        status: 'pending' as const,
        publishedAt: null,
        error: null,
      };
    });
  }

  private readInstagramExtras(input: {
    instagramUserTags?: string;
    instagramCollaborators?: string;
    instagramAddOn?: string;
    instagramPollOptions?: string;
    instagramPollOpenEnded?: boolean;
  }): InstagramDetails {
    const addOn = input.instagramAddOn || 'none';
    if (addOn !== 'none' && addOn !== 'poll' && addOn !== 'comment_prompt') {
      throw new BadRequestException('Choose a poll, a comment prompt, or neither.');
    }
    return {
      userTags: this.readUserTags(input.instagramUserTags),
      collaborators: this.readUsernames(input.instagramCollaborators, 'collaborator'),
      addOn,
      pollOptions: this.readPollOptions(input.instagramPollOptions),
      pollOpenEnded: input.instagramPollOpenEnded === true,
    };
  }

  private instagramDetails(
    postType: InstagramPostType,
    caption: string,
    media: PostMedia[],
    details: InstagramDetails,
    facebookLogin: boolean,
  ): InstagramDetails {
    if (postType === 'story') return EMPTY_INSTAGRAM_DETAILS;
    if (details.userTags.length > 20) throw new BadRequestException('You can tag up to 20 people.');
    const placeOnImage = postType === 'feed' && media[0]?.resourceType === 'image';
    for (const tag of details.userTags) {
      if (placeOnImage && (tag.x == null || tag.y == null || tag.x < 0 || tag.x > 1 || tag.y < 0 || tag.y > 1)) {
        throw new BadRequestException('Click the image to place each tagged person.');
      }
    }
    if (details.collaborators.length > 3) throw new BadRequestException('You can invite up to 3 collaborators.');
    if (details.collaborators.length > 0 && !facebookLogin) {
      throw new BadRequestException('Collaborators are available for Instagram accounts connected with Facebook Login.');
    }
    if ((details.addOn === 'poll' || details.addOn === 'comment_prompt') && !facebookLogin) {
      throw new BadRequestException('Polls and comment prompts are available for Instagram accounts connected with Facebook Login.');
    }
    if (details.addOn === 'comment_prompt' && !caption.trim()) {
      throw new BadRequestException('Add a caption. Instagram uses it as the comment prompt.');
    }
    if (details.addOn === 'poll') {
      if (!caption.trim()) throw new BadRequestException('Add a caption. Instagram uses it as the poll question.');
      if (details.pollOptions.length < 2 || details.pollOptions.length > 4) {
        throw new BadRequestException('A poll needs 2 to 4 options.');
      }
      if (details.pollOptions.some((option) => Array.from(option).length > 25)) {
        throw new BadRequestException('Each poll option can be 25 characters.');
      }
      const keys = ['option_a', 'option_b', 'option_c', 'option_d'];
      const attachment = Object.fromEntries(details.pollOptions.map((option, index) => [keys[index], option]));
      if (JSON.stringify(attachment).length > 200) {
        throw new BadRequestException('Those poll options are too long for Instagram.');
      }
    }
    return {
      ...details,
      userTags: details.userTags.map((tag) => (placeOnImage ? tag : { username: tag.username, x: null, y: null })),
    };
  }

  private readUserTags(value: string | undefined): InstagramUserTagInput[] {
    const rows = this.readJsonArray(value, 'The tagged accounts could not be read.');
    const tags: InstagramUserTagInput[] = [];
    for (const row of rows) {
      const record = row && typeof row === 'object' ? (row as { username?: unknown; x?: unknown; y?: unknown }) : {};
      const username = this.instagramUsername(record.username);
      if (!username) throw new BadRequestException('Enter a public Instagram username to tag.');
      if (tags.some((tag) => tag.username.toLowerCase() === username.toLowerCase())) continue;
      const x = typeof record.x === 'number' ? record.x : null;
      const y = typeof record.y === 'number' ? record.y : null;
      tags.push({ username, x, y });
    }
    return tags;
  }

  private readPollOptions(value: string | undefined): string[] {
    return this.readJsonArray(value, 'The poll options could not be read.')
      .map((option) => (typeof option === 'string' ? option.trim() : ''))
      .filter(Boolean);
  }

  private readUsernames(value: string | undefined, label: string): string[] {
    const names: string[] = [];
    for (const item of this.readJsonArray(value, `The ${label} list could not be read.`)) {
      const username = this.instagramUsername(item);
      if (!username) throw new BadRequestException(`Enter a public Instagram username for each ${label}.`);
      if (!names.some((name) => name.toLowerCase() === username.toLowerCase())) names.push(username);
    }
    return names;
  }

  private readJsonArray(value: string | undefined, message: string): unknown[] {
    if (!value?.trim()) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed;
    } catch {
      throw new BadRequestException(message);
    }
  }

  private instagramFailure(err: unknown, entry: { userTags?: Array<{ username: string }>; collaborators?: string[] }): string {
    const fallback = err instanceof Error ? err.message : 'Instagram did not publish the post';
    if (!(err instanceof InstagramGraphError) || err.code !== 110) return fallback;
    const names = [
      ...(entry.userTags ?? []).map((tag) => `@${tag.username}`),
      ...(entry.collaborators ?? []).map((username) => `@${username}`),
    ];
    if (names.length === 0) return fallback;
    return `Instagram could not find ${names.join(', ')}. Use a public account.`;
  }

  private instagramUsername(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const username = value.trim().replace(/^@+/, '');
    return /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : null;
  }

  private async publishInstagramTargets(doc: PostDocument, retryLater: boolean): Promise<boolean> {
    let retry = false;
    const commentTargets = new Set(doc.commentPageIds ?? []);
    for (const entry of doc.instagram) {
      const wantsComment =
        (entry.postType === 'feed' || entry.postType === 'reel') &&
        Boolean(doc.firstComment) &&
        commentTargets.has(entry.connectedAccountId) &&
        !entry.firstCommentId;
      if (entry.status === 'published' && !wantsComment) continue;
      const account = await this.connectedAccountsService.getInstagramAccountForPublish(doc.workspaceId, entry.connectedAccountId);
      if (!account) {
        if (entry.status !== 'published') {
          entry.status = 'failed';
          entry.error = 'This Instagram account is no longer connected.';
        }
        continue;
      }
      const media = doc.media.find((item) => item.resourceType === 'image' || item.resourceType === 'video');
      if (entry.status !== 'published') {
        if (!media) {
          entry.status = 'failed';
          entry.error = 'Instagram needs an image or a video.';
          continue;
        }
        try {
          entry.instagramMediaId = await this.instagramPublishService.publish({
            accountId: account.accountId,
            accessToken: account.accessToken,
            host: account.host,
            postType: entry.postType,
            caption: entry.caption || '',
            media,
            userTags: entry.userTags ?? [],
            collaborators: account.host === 'facebook' ? (entry.collaborators ?? []) : [],
            addOn: account.host === 'facebook' ? (entry.addOn ?? 'none') : 'none',
            pollOptions: account.host === 'facebook' ? (entry.pollOptions ?? []) : [],
            pollOpenEnded: account.host === 'facebook' ? Boolean(entry.pollOpenEnded) : false,
          });
          entry.status = 'published';
          entry.publishedAt = new Date();
          entry.error = null;
        } catch (err) {
          const message = this.instagramFailure(err, entry);
          if (retryLater && isRetryablePublishError(err)) {
            entry.status = 'pending';
            entry.error = message;
            retry = true;
          } else {
            entry.status = 'failed';
            entry.error = message;
          }
          doc.markModified('instagram');
          await doc.save();
          continue;
        }
      }
      if (wantsComment && entry.instagramMediaId && doc.firstComment) {
        try {
          entry.firstCommentId = await this.instagramPublishService.publishComment({
            mediaId: entry.instagramMediaId,
            accessToken: account.accessToken,
            host: account.host,
            message: doc.firstComment,
          });
          entry.firstCommentError = null;
        } catch (commentError) {
          const message = commentError instanceof Error ? commentError.message : 'Instagram did not post the comment';
          const missingPermission =
            commentError instanceof InstagramGraphError &&
            (commentError.code === 10 || commentError.code === 200 || commentError.code === 190);
          entry.firstCommentError = missingPermission
            ? `${message} Reconnect the Instagram account from Accounts so it can post comments.`
            : message;
        }
      }
      doc.markModified('instagram');
      await doc.save();
    }
    return retry;
  }

  private assertInstagram(postType: InstagramPostType, caption: string, media: PostMedia[]) {
    if ((postType === 'feed' || postType === 'reel') && Array.from(caption).length > INSTAGRAM_CAPTION_LIMIT) {
      throw new BadRequestException('Instagram captions are limited to 2,200 characters.');
    }
    const item = media[0];
    const format = item?.format?.toLowerCase() ?? '';
    if (postType === 'feed') {
      if (media.length !== 1 || item?.resourceType !== 'image') {
        throw new BadRequestException('An Instagram Feed post needs one image.');
      }
      if (format && !['jpg', 'jpeg', 'png'].includes(format)) {
        throw new BadRequestException('An Instagram Feed image needs to be a JPEG or PNG.');
      }
      return;
    }
    if (postType === 'reel') {
      if (media.length !== 1 || item?.resourceType !== 'video') {
        throw new BadRequestException('An Instagram Reel needs one video.');
      }
      if (format && !['mp4', 'mov'].includes(format)) {
        throw new BadRequestException('An Instagram Reel needs an MP4 video.');
      }
      if (item.duration && (item.duration < 3 || item.duration > 90)) {
        throw new BadRequestException('An Instagram Reel needs to be between 3 and 90 seconds.');
      }
      return;
    }
    if (media.length !== 1 || !item) {
      throw new BadRequestException('An Instagram Story needs one image or one video.');
    }
    if (item.resourceType === 'image' && format && !['jpg', 'jpeg', 'png'].includes(format)) {
      throw new BadRequestException('An Instagram Story image needs to be a JPEG or PNG.');
    }
    if (item.resourceType === 'video' && format && !['mp4', 'mov'].includes(format)) {
      throw new BadRequestException('An Instagram Story video needs to be an MP4.');
    }
    if (item.resourceType === 'video' && item.duration && item.duration > 60) {
      throw new BadRequestException('An Instagram Story video needs to be 60 seconds or shorter.');
    }
  }

  private visualMedia(media: PostMedia[]): PostMedia[] {
    return media.filter((item) => item.resourceType !== 'document');
  }

  private async withLinkedIn(workspaceId: string, input: LinkedInFields, fallbackCaption: string, media: PostMedia[]) {
    const accountIds = this.uniqueIds(input.linkedinAccountIds ?? []);
    if (accountIds.length === 0) {
      return { entries: [], media: this.visualMedia(media) };
    }
    const postType = input.linkedinPostType ?? 'normal';
    const caption = (input.linkedinCaption ?? fallbackCaption).trim();
    let nextMedia = postType === 'carousel' ? media : this.visualMedia(media);
    if (postType === 'carousel' && input.linkedinPdf) {
      const document = await this.cloudinaryService.uploadDocument(input.linkedinPdf);
      nextMedia = [...this.visualMedia(media), document];
    }
    const details = this.linkedinDetails(postType, caption, nextMedia, input);
    const targets = await this.linkedinTargetsFor(workspaceId, accountIds);
    const ordered = [...this.visualMedia(nextMedia), ...nextMedia.filter((item) => item.resourceType === 'document')];
    return { entries: this.linkedinEntries(targets, postType, caption, details), media: ordered };
  }

  private linkedinDetails(postType: LinkedInPostType, caption: string, media: PostMedia[], input: LinkedInFields): LinkedInDetails {
    if (Array.from(caption).length > LINKEDIN_CAPTION_LIMIT) {
      throw new BadRequestException('LinkedIn text is limited to 3,000 characters.');
    }
    const images = media.filter((item) => item.resourceType === 'image');
    const documents = media.filter((item) => item.resourceType === 'document');
    const imageFormat = (item: PostMedia) => item.format?.toLowerCase() ?? '';
    if (postType === 'normal') {
      if (!caption && images.length === 0) throw new BadRequestException('A LinkedIn post needs text or an image.');
      if (images.length > 20) throw new BadRequestException('A LinkedIn post can include up to 20 images.');
      if (images.some((item) => imageFormat(item) && !['jpg', 'jpeg', 'png', 'gif'].includes(imageFormat(item)))) {
        throw new BadRequestException('LinkedIn images need to be JPEG, PNG, or GIF.');
      }
    }
    const question = input.linkedinPollQuestion?.trim() ?? '';
    const options = this.readStringList(input.linkedinPollOptions);
    const duration = (['ONE_DAY', 'THREE_DAYS', 'SEVEN_DAYS', 'FOURTEEN_DAYS'] as const).find((item) => item === input.linkedinPollDuration) ?? 'SEVEN_DAYS';
    const title = input.linkedinCarouselTitle?.trim() ?? '';
    if (postType === 'poll') {
      if (!question || Array.from(question).length > 140) throw new BadRequestException('A LinkedIn poll question can be 140 characters.');
      if (options.length < 2 || options.length > 4) throw new BadRequestException('A LinkedIn poll needs 2 to 4 options.');
      if (options.some((option) => Array.from(option).length > 30)) throw new BadRequestException('Each LinkedIn poll option can be 30 characters.');
    }
    if (postType === 'carousel') {
      if (!title || Array.from(title).length > 400) throw new BadRequestException('A carousel title can be 400 characters.');
      if (documents.length === 0 && (images.length < 1 || images.length > 20)) {
        throw new BadRequestException('A LinkedIn carousel needs a PDF or 1 to 20 images.');
      }
      if (documents.length === 0 && images.some((item) => !['jpg', 'jpeg', 'png'].includes(imageFormat(item)))) {
        throw new BadRequestException('Carousel images need to be JPEG or PNG. Upload a PDF to use other files.');
      }
    }
    return { pollQuestion: question, pollOptions: options, pollDuration: duration, carouselTitle: title };
  }

  private readStringList(value: string | undefined): string[] {
    if (!value?.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException('The LinkedIn poll options could not be read.');
    }
    if (!Array.isArray(parsed)) throw new BadRequestException('The LinkedIn poll options could not be read.');
    return parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }

  private async linkedinTargetsFor(workspaceId: string, accountIds: string[]) {
    const targets: Array<{ connectedAccountId: string; accountId: string; name: string }> = [];
    for (const accountId of accountIds) {
      const account = await this.connectedAccountsService.getLinkedInAccountForPublish(workspaceId, accountId);
      if (!account) throw new BadRequestException('Reconnect the LinkedIn profile from Accounts.');
      targets.push(account);
    }
    return targets;
  }

  private linkedinEntries(
    targets: Array<{ connectedAccountId: string; accountId: string; name: string }>,
    postType: LinkedInPostType,
    caption: string,
    details: LinkedInDetails,
  ) {
    return targets.map((target) => ({
      connectedAccountId: target.connectedAccountId,
      accountId: target.accountId,
      name: target.name,
      postType,
      caption,
      pollQuestion: postType === 'poll' ? details.pollQuestion : '',
      pollOptions: postType === 'poll' ? details.pollOptions : [],
      pollDuration: details.pollDuration,
      carouselTitle: postType === 'carousel' ? details.carouselTitle : '',
      linkedinPostId: null,
      status: 'pending' as const,
      publishedAt: null,
      error: null,
    }));
  }

  private async publishLinkedInTargets(doc: PostDocument, retryLater: boolean): Promise<boolean> {
    let retry = false;
    for (const entry of doc.linkedin) {
      if (entry.status === 'published') continue;
      const account = await this.connectedAccountsService.getLinkedInAccountForPublish(doc.workspaceId, entry.connectedAccountId);
      if (!account) {
        entry.status = 'failed';
        entry.error = 'This LinkedIn profile is no longer connected.';
        doc.markModified('linkedin');
        await doc.save();
        continue;
      }
      try {
        entry.linkedinPostId = await this.linkedInPublishService.publish({
          accountId: account.accountId,
          accessToken: account.accessToken,
          postType: entry.postType,
          caption: entry.caption || '',
          media: doc.media,
          pollQuestion: entry.pollQuestion || '',
          pollOptions: entry.pollOptions ?? [],
          pollDuration: entry.pollDuration,
          carouselTitle: entry.carouselTitle || '',
        });
        entry.status = 'published';
        entry.publishedAt = new Date();
        entry.error = null;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'LinkedIn did not publish the post';
        const retryableStatus = err instanceof LinkedInPublishError && (err.status === 429 || (err.status ?? 0) >= 500);
        if (retryLater && (isRetryablePublishError(err) || retryableStatus)) {
          entry.status = 'pending';
          entry.error = message;
          retry = true;
        } else {
          entry.status = 'failed';
          entry.error = message;
        }
      }
      doc.markModified('linkedin');
      await doc.save();
    }
    return retry;
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
      instagram: (doc.instagram ?? []).map((item) => ({
        connectedAccountId: item.connectedAccountId,
        accountId: item.accountId,
        name: item.name,
        username: item.username ?? null,
        postType: item.postType,
        caption: item.caption ?? '',
        userTags: (item.userTags ?? []).map((tag) => ({
          username: tag.username,
          x: tag.x ?? null,
          y: tag.y ?? null,
        })),
        collaborators: item.collaborators ?? [],
        addOn: item.addOn ?? 'none',
        pollOptions: item.pollOptions ?? [],
        pollOpenEnded: item.pollOpenEnded ?? false,
        instagramMediaId: item.instagramMediaId ?? null,
        status: item.status,
        publishedAt: item.publishedAt ?? null,
        error: item.error ?? null,
        firstCommentId: item.firstCommentId ?? null,
        firstCommentError: item.firstCommentError ?? null,
      })),
      linkedin: (doc.linkedin ?? []).map((item) => ({
        connectedAccountId: item.connectedAccountId,
        accountId: item.accountId,
        name: item.name,
        postType: item.postType,
        caption: item.caption ?? '',
        pollQuestion: item.pollQuestion ?? '',
        pollOptions: item.pollOptions ?? [],
        pollDuration: item.pollDuration ?? 'SEVEN_DAYS',
        carouselTitle: item.carouselTitle ?? '',
        linkedinPostId: item.linkedinPostId ?? null,
        status: item.status,
        publishedAt: item.publishedAt ?? null,
        error: item.error ?? null,
      })),
      createdAt: doc.createdAt,
      completedAt: doc.completedAt ?? null,
    };
  }
}
