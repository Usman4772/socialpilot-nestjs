import { Injectable } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

import { LinkedInPollDuration, LinkedInPostType, PostMedia } from './schemas/post.schema';

const VERSION = '202609';

export class LinkedInPublishError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

@Injectable()
export class LinkedInPublishService {
  async publish(input: {
    accountId: string;
    accessToken: string;
    postType: LinkedInPostType;
    caption: string;
    media: PostMedia[];
    pollQuestion: string;
    pollOptions: string[];
    pollDuration: LinkedInPollDuration;
    carouselTitle: string;
  }): Promise<string> {
    const author = `urn:li:person:${input.accountId}`;
    if (input.postType === 'poll') {
      return this.createPost(input.accessToken, {
        author,
        commentary: input.caption,
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        distribution: this.distribution(),
        isReshareDisabledByAuthor: false,
        content: {
          poll: {
            question: input.pollQuestion,
            options: input.pollOptions.map((text) => ({ text })),
            settings: { duration: input.pollDuration },
          },
        },
      });
    }
    if (input.postType === 'carousel') {
      const document = input.media.find((item) => item.resourceType === 'document');
      const pdf = document
        ? await this.download(document.secureUrl)
        : await this.imagesToPdf(input.media.filter((item) => item.resourceType === 'image').slice(0, 20));
      const urn = await this.uploadAsset(input.accessToken, author, 'documents', pdf, 'application/pdf');
      return this.createPost(input.accessToken, {
        author,
        commentary: input.caption,
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        distribution: this.distribution(),
        isReshareDisabledByAuthor: false,
        content: { media: { title: input.carouselTitle, id: urn } },
      });
    }
    const images = input.media.filter((item) => item.resourceType === 'image').slice(0, 20);
    const urns: string[] = [];
    for (const image of images) {
      const bytes = await this.download(image.secureUrl);
      urns.push(await this.uploadAsset(input.accessToken, author, 'images', bytes, this.imageType(image)));
    }
    const content =
      urns.length === 0
        ? undefined
        : urns.length === 1
          ? { media: { id: urns[0] } }
          : { multiImage: { images: urns.map((id) => ({ id })) } };
    return this.createPost(input.accessToken, {
      author,
      commentary: input.caption,
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
      distribution: this.distribution(),
      isReshareDisabledByAuthor: false,
      ...(content ? { content } : {}),
    });
  }

  private distribution() {
    return { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] };
  }

  private async imagesToPdf(images: PostMedia[]): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    for (const image of images) {
      const bytes = await this.download(image.secureUrl);
      const type = this.imageType(image);
      const embedded = type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const maxWidth = 1080;
      const scale = embedded.width > maxWidth ? maxWidth / embedded.width : 1;
      const width = embedded.width * scale;
      const height = embedded.height * scale;
      const page = pdf.addPage([width, height]);
      page.drawImage(embedded, { x: 0, y: 0, width, height });
    }
    return pdf.save();
  }

  private imageType(image: PostMedia): string {
    const format = image.format?.toLowerCase() ?? '';
    if (format === 'png') return 'image/png';
    if (format === 'gif') return 'image/gif';
    return 'image/jpeg';
  }

  private async uploadAsset(
    accessToken: string,
    owner: string,
    kind: 'images' | 'documents',
    bytes: Uint8Array,
    contentType: string,
  ): Promise<string> {
    const start = await fetch(`https://api.linkedin.com/rest/${kind}?action=initializeUpload`, {
      method: 'POST',
      headers: this.headers(accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });
    const started = (await start.json()) as {
      message?: string;
      value?: { uploadUrl?: string; image?: string; document?: string };
    };
    const uploadUrl = started.value?.uploadUrl;
    const urn = started.value?.image || started.value?.document;
    if (!start.ok || !uploadUrl || !urn) {
      throw new LinkedInPublishError(started.message || 'LinkedIn did not accept the file.', start.status);
    }
    const uploaded = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': contentType },
      body: Buffer.from(bytes),
    });
    if (!uploaded.ok) {
      throw new LinkedInPublishError('LinkedIn did not accept the file.', uploaded.status);
    }
    return urn;
  }

  private async createPost(accessToken: string, body: Record<string, unknown>): Promise<string> {
    let lastError = 'LinkedIn did not publish the post.';
    let lastStatus = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch('https://api.linkedin.com/rest/posts', {
        method: 'POST',
        headers: this.headers(accessToken),
        body: JSON.stringify(body),
      });
      if (response.status === 201) {
        const id = response.headers.get('x-restli-id');
        if (!id) throw new LinkedInPublishError('LinkedIn published the post without an id.');
        return id;
      }
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      lastError = payload.message || lastError;
      lastStatus = response.status;
      const waiting = /process|not ready|asset|please try again/i.test(lastError);
      if (!waiting || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new LinkedInPublishError(lastError, lastStatus);
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': VERSION,
    };
  }

  private async download(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) throw new LinkedInPublishError('The media could not be read for LinkedIn.');
    return new Uint8Array(await response.arrayBuffer());
  }
}
