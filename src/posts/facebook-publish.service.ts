import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PostMedia } from './schemas/post.schema';

type GraphErrorBody = {
  error?: { message?: string; code?: number };
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

  async publishFeed(input: {
    pageId: string;
    accessToken: string;
    caption: string;
    media: PostMedia[];
  }): Promise<string> {
    const images = input.media.filter((item) => item.resourceType === 'image');
    const videos = input.media.filter((item) => item.resourceType === 'video');

    if (videos.length === 1 && images.length === 0) {
      const fields: Record<string, string> = { file_url: videos[0].secureUrl };
      if (input.caption.trim()) fields.description = input.caption;
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
    return `${pageId}_${publishedId}`;
  }

  private async graphPost(
    path: string,
    accessToken: string,
    fields: Record<string, string>,
  ): Promise<{ id?: string; post_id?: string }> {
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
    const body = (await response.json()) as { id?: string; post_id?: string } & GraphErrorBody;
    if (!response.ok || body.error || !body.id) {
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
