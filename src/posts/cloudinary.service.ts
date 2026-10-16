import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Agent, FormData, fetch as undiciFetch } from 'undici';

import { isDevelopment } from '../common/utils/environment';
import { PostMedia } from './schemas/post.schema';

const CONNECT_TIMEOUT_MS = 30_000;
const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;
const VIDEO_UPLOAD_TIMEOUT_MS = 15 * 60_000;

const imageDispatcher = new Agent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: IMAGE_UPLOAD_TIMEOUT_MS,
  bodyTimeout: IMAGE_UPLOAD_TIMEOUT_MS,
});

const videoDispatcher = new Agent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: VIDEO_UPLOAD_TIMEOUT_MS,
  bodyTimeout: VIDEO_UPLOAD_TIMEOUT_MS,
});

export type UploadableFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

type CloudinaryUploadResponse = {
  public_id?: string;
  secure_url?: string;
  resource_type?: string;
  format?: string;
  width?: number;
  height?: number;
  bytes?: number;
  duration?: number;
  error?: { message?: string };
};

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private readonly configService: ConfigService) {}

  async upload(file: UploadableFile): Promise<PostMedia> {
    const resourceType = file.mimetype.startsWith('video/') ? 'video' : 'image';
    const started = Date.now();
    if (isDevelopment()) {
      this.logger.log(`Uploading ${resourceType} (${file.size} bytes, ${file.mimetype})`);
    }
    const body = await this.send(file, resourceType);
    if (isDevelopment()) {
      this.logger.log(`Uploaded ${resourceType} ${body.public_id} in ${Date.now() - started}ms`);
    }

    return {
      publicId: body.public_id!,
      secureUrl: body.secure_url!,
      resourceType,
      format: body.format ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      bytes: body.bytes ?? file.size,
      duration: body.duration ?? null,
    };
  }

  private async send(file: UploadableFile, resourceType: 'image' | 'video' | 'raw'): Promise<CloudinaryUploadResponse> {
    const cloudName = this.required('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.required('CLOUDINARY_API_KEY');
    const apiSecret = this.required('CLOUDINARY_API_SECRET');
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'social-hub/posts';
    const signature = createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`)
      .digest('hex');
    const form = new FormData();
    const bytes = new Uint8Array(file.buffer);
    form.append('file', new Blob([bytes], { type: file.mimetype }), file.originalname || 'upload');
    form.append('api_key', apiKey);
    form.append('timestamp', String(timestamp));
    form.append('signature', signature);
    form.append('folder', folder);
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
        method: 'POST',
        body: form,
        dispatcher: resourceType === 'video' ? videoDispatcher : imageDispatcher,
      });
    } catch (err) {
      throw this.uploadFailed(resourceType === 'raw' ? 'image' : resourceType, err);
    }
    let body: CloudinaryUploadResponse;
    try {
      body = (await response.json()) as CloudinaryUploadResponse;
    } catch (err) {
      throw this.uploadFailed(resourceType === 'raw' ? 'image' : resourceType, err);
    }
    if (!response.ok || !body.public_id || !body.secure_url) {
      throw new BadRequestException(body.error?.message || (resourceType === 'raw' ? 'The PDF could not be uploaded. Please try again.' : this.friendlyMessage(resourceType)));
    }
    return body;
  }

  async uploadDocument(file: UploadableFile): Promise<PostMedia> {
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('A LinkedIn carousel file needs to be a PDF.');
    }
    if (file.size > 100 * 1024 * 1024) {
      throw new BadRequestException('A LinkedIn carousel PDF must be 100 MB or smaller.');
    }
    const body = await this.send(file, 'raw');
    return {
      publicId: body.public_id!,
      secureUrl: body.secure_url!,
      resourceType: 'document',
      format: 'pdf',
      width: null,
      height: null,
      bytes: body.bytes ?? file.size,
      duration: null,
    };
  }

  private uploadFailed(resourceType: 'image' | 'video', err: unknown): BadRequestException {
    const cause = err instanceof Error && 'cause' in err ? err.cause : err;
    const detail = cause instanceof Error ? cause.message : 'unknown error';
    this.logger.warn(`Cloudinary ${resourceType} upload failed: ${detail}`);
    return new BadRequestException(this.friendlyMessage(resourceType));
  }

  private friendlyMessage(resourceType: 'image' | 'video'): string {
    return resourceType === 'video'
      ? 'The video could not be uploaded. Please try again.'
      : 'The image could not be uploaded. Please try again.';
  }

  private required(name: string): string {
    const value = this.configService.get<string>(name)?.trim();
    if (!value) {
      throw new BadRequestException(`${name} is not configured`);
    }
    return value;
  }
}
