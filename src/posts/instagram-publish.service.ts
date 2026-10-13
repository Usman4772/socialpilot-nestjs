import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isDevelopment } from '../common/utils/environment';
import { InstagramAddOn, PostMedia } from './schemas/post.schema';

type GraphErrorBody = {
  error?: { message?: string; code?: number };
};

export class InstagramGraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

@Injectable()
export class InstagramPublishService {
  private readonly logger = new Logger(InstagramPublishService.name);

  constructor(private readonly configService: ConfigService) {}

  async publish(input: {
    accountId: string;
    accessToken: string;
    host: 'instagram' | 'facebook';
    postType: 'feed' | 'reel' | 'story';
    caption: string;
    media: PostMedia;
    userTags?: Array<{ username: string; x?: number | null; y?: number | null }>;
    collaborators?: string[];
    addOn?: InstagramAddOn;
    pollOptions?: string[];
    pollOpenEnded?: boolean;
  }): Promise<string> {
    const started = Date.now();
    this.dev(`Creating ${input.postType} container for ${input.accountId} via ${input.host}`);
    const fields = this.containerFields(input);
    const container = await this.graph(input.host, `/${input.accountId}/media`, input.accessToken, fields);
    const containerId = String(container.id || '');
    if (!containerId) {
      throw new InstagramGraphError('Instagram did not accept the media.');
    }
    this.dev(`Container ${containerId} created for ${input.accountId}`);
    const attempts = input.postType === 'reel' || input.media.resourceType === 'video' ? 45 : 5;
    await this.waitUntilReady(input.host, containerId, input.accessToken, attempts);
    const published = await this.graph(input.host, `/${input.accountId}/media_publish`, input.accessToken, {
      creation_id: containerId,
    });
    const mediaId = String(published.id || '');
    if (!mediaId) {
      throw new InstagramGraphError('Instagram did not publish the post.');
    }
    this.dev(`Published ${input.postType} ${mediaId} for ${input.accountId} in ${Date.now() - started}ms`);
    return mediaId;
  }

  async publishComment(input: {
    mediaId: string;
    accessToken: string;
    host: 'instagram' | 'facebook';
    message: string;
  }): Promise<string> {
    this.dev(`Posting first comment on ${input.mediaId}`);
    const body = await this.graph(input.host, `/${input.mediaId}/comments`, input.accessToken, {
      message: input.message,
    });
    const commentId = String(body.id || '');
    if (!commentId) {
      throw new InstagramGraphError('Instagram did not post the comment.');
    }
    return commentId;
  }

  private containerFields(input: {
    host: 'instagram' | 'facebook';
    postType: 'feed' | 'reel' | 'story';
    caption: string;
    media: PostMedia;
    userTags?: Array<{ username: string; x?: number | null; y?: number | null }>;
    collaborators?: string[];
    addOn?: InstagramAddOn;
    pollOptions?: string[];
    pollOpenEnded?: boolean;
  }): Record<string, string> {
    const caption = input.caption.trim();
    const extras = input.postType === 'story' ? {} : this.extraFields(input, caption);
    if (input.postType === 'reel') {
      return {
        media_type: 'REELS',
        video_url: input.media.secureUrl,
        share_to_feed: 'true',
        ...(caption ? { caption } : {}),
        ...extras,
      };
    }
    if (input.postType === 'story') {
      return input.media.resourceType === 'video'
        ? { media_type: 'STORIES', video_url: input.media.secureUrl }
        : { media_type: 'STORIES', image_url: input.media.secureUrl };
    }
    return {
      image_url: input.media.secureUrl,
      ...(caption ? { caption } : {}),
      ...extras,
    };
  }

  private extraFields(
    input: {
      host: 'instagram' | 'facebook';
      postType: 'feed' | 'reel' | 'story';
      userTags?: Array<{ username: string; x?: number | null; y?: number | null }>;
      collaborators?: string[];
      addOn?: InstagramAddOn;
      pollOptions?: string[];
      pollOpenEnded?: boolean;
    },
    caption: string,
  ): Record<string, string> {
    const fields: Record<string, string> = {};
    const tags = (input.userTags ?? []).filter((tag) => tag.username);
    if (tags.length > 0) {
      fields.user_tags = `[${tags
        .map((tag) =>
          input.postType === 'feed' && tag.x != null && tag.y != null
            ? `{username:'${tag.username}',x:${tag.x},y:${tag.y}}`
            : `{username:'${tag.username}'}`,
        )
        .join(',')}]`;
    }
    if (input.host !== 'facebook') return fields;
    if (input.collaborators?.length) {
      fields.collaborators = `[${input.collaborators.map((username) => `'${username}'`).join(',')}]`;
    }
    if (input.addOn === 'poll' && caption) {
      const keys = ['option_a', 'option_b', 'option_c', 'option_d'] as const;
      const attachment: Record<string, string> = {};
      (input.pollOptions ?? []).slice(0, 4).forEach((option, index) => {
        attachment[keys[index]] = option;
      });
      fields.poll_attachment = JSON.stringify(attachment);
      if (input.pollOpenEnded) fields.is_poll_duration_extended = 'true';
    }
    if (input.addOn === 'comment_prompt' && caption) fields.is_comment_prompt_used = 'true';
    return fields;
  }

  private async waitUntilReady(
    host: 'instagram' | 'facebook',
    containerId: string,
    accessToken: string,
    attempts: number,
  ): Promise<void> {
    let lastStatus = '';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const body = await this.graph(host, `/${containerId}`, accessToken, { fields: 'status_code,status' }, 'GET');
      const status = String(body.status_code || 'pending');
      if (status !== lastStatus) {
        lastStatus = status;
        this.dev(`Container ${containerId} status ${status}`);
      }
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        const detail = typeof body.status === 'string' ? body.status.trim() : '';
        throw new InstagramGraphError(detail || 'Instagram could not process the media.');
      }
      if (status === 'PUBLISHED') return;
      await this.delay(4000);
    }
    throw new InstagramGraphError('Instagram is still processing the video. It will be tried again.');
  }

  private async graph(
    host: 'instagram' | 'facebook',
    path: string,
    accessToken: string,
    fields: Record<string, string> = {},
    method: 'GET' | 'POST' = 'POST',
  ): Promise<{ id?: string; status_code?: string; status?: string }> {
    const base = host === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
    const query = new URLSearchParams({ access_token: accessToken });
    if (method === 'GET') {
      for (const [key, value] of Object.entries(fields)) query.set(key, value);
    }
    const response = await fetch(`${base}/${this.graphVersion()}${path}?${query.toString()}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
      body: method === 'POST' ? new URLSearchParams(fields) : undefined,
    });
    const body = (await response.json()) as { id?: string; status_code?: string; status?: string } & GraphErrorBody;
    if (!response.ok || body.error) {
      throw new InstagramGraphError(body.error?.message || 'Instagram did not accept the post.', body.error?.code);
    }
    return body;
  }

  private graphVersion(): string {
    return (this.configService.get<string>('FACEBOOK_GRAPH_VERSION') || 'v23.0').replace(/^\/+|\/+$/g, '');
  }

  private dev(message: string): void {
    if (isDevelopment()) this.logger.log(message);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
