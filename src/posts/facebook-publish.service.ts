import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PostMedia } from './schemas/post.schema';

type GraphErrorBody = {
  error?: { message?: string; code?: number };
  debug_info?: { message?: string };
};

export class FacebookGraphError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

@Injectable()
export class FacebookPublishService {
  constructor(private readonly configService: ConfigService) {}

  async publish(input: {
    pageId: string;
    accessToken: string;
    caption: string;
    media: PostMedia[];
    postType: 'feed' | 'reel' | 'story' | 'carousel';
    videoTitle?: string | null;
    aiGenerated?: boolean | null;
  }): Promise<string> {
    if (input.postType === 'reel') return this.publishReel(input);
    if (input.postType === 'story') return this.publishStory(input);
    if (input.postType === 'carousel') return this.publishCarousel(input);
    return this.publishFeed(input);
  }

  async publishFeed(input: {
    pageId: string;
    accessToken: string;
    caption: string;
    media: PostMedia[];
    videoTitle?: string | null;
    aiGenerated?: boolean | null;
  }): Promise<string> {
    const images = input.media.filter((item) => item.resourceType === 'image');
    const videos = input.media.filter((item) => item.resourceType === 'video');

    if (videos.length === 1 && images.length === 0) {
      const fields: Record<string, string> = { file_url: videos[0].secureUrl };
      if (input.caption.trim()) fields.description = input.caption;
      if (input.videoTitle?.trim()) fields.title = input.videoTitle.trim();
      const body = await this.graphPost(`/${input.pageId}/videos`, input.accessToken, fields);
      return this.storyId(input.pageId, String(body.id), input.accessToken);
    }

    if (images.length === 1 && videos.length === 0) {
      const fields: Record<string, string> = { url: images[0].secureUrl };
      if (input.caption.trim()) fields.caption = input.caption;
      const body = await this.graphPost(`/${input.pageId}/photos`, input.accessToken, fields);
      return this.storyId(input.pageId, String(body.post_id || body.id), input.accessToken);
    }

    if (images.length > 1 && videos.length === 0) {
      const photoIds: string[] = [];
      for (const image of images) {
        const uploaded = await this.graphPost(`/${input.pageId}/photos`, input.accessToken, {
          url: image.secureUrl,
          published: 'false',
        });
        photoIds.push(String(uploaded.id));
      }
      const fields: Record<string, string> = {};
      if (input.caption.trim()) {
        fields.message = input.caption;
      }
      photoIds.forEach((photoId, index) => {
        fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: photoId });
      });
      const body = await this.graphPost(`/${input.pageId}/feed`, input.accessToken, fields);
      return String(body.id);
    }

    const body = await this.graphPost(`/${input.pageId}/feed`, input.accessToken, {
      message: input.caption,
    });
    return String(body.id);
  }

  private async publishCarousel(input: {
    pageId: string;
    accessToken: string;
    caption: string;
    media: PostMedia[];
  }): Promise<string> {
    const photoIds: string[] = [];
    for (const image of input.media) {
      const uploaded = await this.graphPost(`/${input.pageId}/photos`, input.accessToken, {
        url: image.secureUrl,
        published: 'false',
      });
      photoIds.push(String(uploaded.id));
    }
    const fields: Record<string, string> = {};
    if (input.caption.trim()) fields.message = input.caption;
    photoIds.forEach((photoId, index) => {
      fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: photoId });
    });
    const body = await this.graphPost(`/${input.pageId}/feed`, input.accessToken, fields);
    return String(body.id);
  }

  private async publishStory(input: {
    pageId: string;
    accessToken: string;
    media: PostMedia[];
    aiGenerated?: boolean | null;
  }): Promise<string> {
    const item = input.media[0];
    if (item.resourceType === 'image') {
      const uploaded = await this.graphPost(`/${input.pageId}/photos`, input.accessToken, {
        url: item.secureUrl,
        published: 'false',
      });
      const story = await this.graphPost(`/${input.pageId}/photo_stories`, input.accessToken, {
        photo_id: String(uploaded.id),
      });
      return String(story.post_id || story.id);
    }

    const started = await this.graphPost(`/${input.pageId}/video_stories`, input.accessToken, {
      upload_phase: 'start',
    });
    const videoId = String(started.video_id || started.id);
    const uploadUrl = started.upload_url;
    if (!uploadUrl) {
      throw new FacebookGraphError('Facebook did not return a story upload URL');
    }
    await this.uploadHostedVideo(uploadUrl, item.secureUrl, input.accessToken);
    const finishedFields: Record<string, string> = { upload_phase: 'finish', video_id: videoId };
    if (input.aiGenerated === true) finishedFields.is_ai_generated = 'true';
    const finished = await this.graphPost(`/${input.pageId}/video_stories`, input.accessToken, finishedFields);
    return String(finished.post_id || finished.video_id || finished.id || videoId);
  }

  private async publishReel(input: {
    pageId: string;
    accessToken: string;
    caption: string;
    media: PostMedia[];
    videoTitle?: string | null;
    aiGenerated?: boolean | null;
  }): Promise<string> {
    const started = await this.graphPost(`/${input.pageId}/video_reels`, input.accessToken, {
      upload_phase: 'start',
    });
    const videoId = String(started.video_id || started.id);
    if (!started.upload_url) {
      throw new FacebookGraphError('Facebook did not return a Reel upload URL');
    }

    await this.uploadHostedVideo(started.upload_url, input.media[0].secureUrl, input.accessToken);

    const fields: Record<string, string> = {
      upload_phase: 'finish',
      video_id: videoId,
      video_state: 'PUBLISHED',
    };
    if (input.caption.trim()) fields.description = input.caption;
    if (input.videoTitle?.trim()) fields.title = input.videoTitle.trim();
    if (input.aiGenerated === true) fields.is_ai_generated = 'true';
    await this.graphPost(`/${input.pageId}/video_reels`, input.accessToken, fields);
    return videoId;
  }

  private async uploadHostedVideo(uploadUrl: string, fileUrl: string, accessToken: string): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_url: fileUrl,
      },
    });
    const body = (await response.json().catch(() => ({}))) as GraphErrorBody & { debug_info?: { message?: string } };
    if (!response.ok || body.error) {
      throw new FacebookGraphError(
        body.error?.message || body.debug_info?.message || 'Facebook could not upload the story video',
        body.error?.code,
      );
    }
  }

  async publishComment(input: {
    pageId: string;
    postId: string;
    accessToken: string;
    message: string;
  }): Promise<string> {
    const storyId = await this.storyId(input.pageId, input.postId, input.accessToken);
    const body = await this.graphPost(`/${storyId}/comments`, input.accessToken, {
      message: input.message,
    });
    return String(body.id);
  }

  /** Feed comments belong on `{page-id}_{story-id}`, not the photo or video id. */
  private async storyId(pageId: string, publishedId: string, accessToken: string): Promise<string> {
    if (publishedId.includes('_')) return publishedId;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const body = await this.graphGet<{ post_id?: string; page_story_id?: string }>(
          `/${publishedId}`,
          accessToken,
          { fields: 'post_id,page_story_id' },
        );
        const story = body.page_story_id || body.post_id;
        if (story?.includes('_')) return story;
        if (story) return `${pageId}_${story}`;
      } catch (err) {
        if (err instanceof FacebookGraphError && (err.code === 10 || err.code === 200 || err.code === 190)) {
          throw err;
        }
      }
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return `${pageId}_${publishedId}`;
  }

  private async graphPost(
    path: string,
    accessToken: string,
    fields: Record<string, string>,
  ): Promise<{ id?: string; post_id?: string; video_id?: string; upload_url?: string; success?: boolean }> {
    const version = (this.configService.get<string>('FACEBOOK_GRAPH_VERSION') || 'v23.0').replace(
      /^\/+|\/+$/g,
      '',
    );
    const params = new URLSearchParams({ ...fields, access_token: accessToken });
    const response = await fetch(`https://graph.facebook.com/${version}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const body = (await response.json()) as {
      id?: string;
      post_id?: string;
      video_id?: string;
      upload_url?: string;
      success?: boolean;
    } & GraphErrorBody;
    if (!response.ok || body.error || (!body.id && !body.post_id && !body.video_id && body.success !== true)) {
      throw new FacebookGraphError(body.error?.message || 'Facebook request failed', body.error?.code);
    }
    return body;
  }

  private async graphGet<T>(path: string, accessToken: string, query: Record<string, string>): Promise<T> {
    const version = (this.configService.get<string>('FACEBOOK_GRAPH_VERSION') || 'v23.0').replace(
      /^\/+|\/+$/g,
      '',
    );
    const params = new URLSearchParams({ ...query, access_token: accessToken });
    const response = await fetch(`https://graph.facebook.com/${version}${path}?${params}`);
    const body = (await response.json()) as T & GraphErrorBody;
    if (!response.ok || body.error) {
      throw new FacebookGraphError(body.error?.message || 'Facebook request failed', body.error?.code);
    }
    return body;
  }
}
