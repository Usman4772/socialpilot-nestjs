import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

import { PostMedia } from './schemas/post.schema';

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
  error?: { message?: string };
};

@Injectable()
export class CloudinaryService {
  constructor(private readonly configService: ConfigService) {}

  async upload(file: UploadableFile): Promise<PostMedia> {
    const resourceType = file.mimetype.startsWith('video/') ? 'video' : 'image';
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

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
      { method: 'POST', body: form },
    );
    const body = (await response.json()) as CloudinaryUploadResponse;
    if (!response.ok || !body.public_id || !body.secure_url) {
      throw new BadRequestException(body.error?.message || 'Cloudinary upload failed');
    }

    return {
      publicId: body.public_id,
      secureUrl: body.secure_url,
      resourceType,
      format: body.format ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      bytes: body.bytes ?? file.size,
    };
  }

  private required(name: string): string {
    const value = this.configService.get<string>(name)?.trim();
    if (!value) {
      throw new BadRequestException(`${name} is not configured`);
    }
    return value;
  }
}
