import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';

import type { JwtAuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UploadableFile } from './cloudinary.service';
import { PostsService } from './posts.service';

@ApiTags('Posts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Post('publish')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: 25 * 1024 * 1024, files: 10 },
    }),
  )
  publish(
    @CurrentUser() authUser: JwtAuthUser,
    @UploadedFiles() files: UploadableFile[] | undefined,
    @Body('caption') caption?: string,
    @Body('pageIds') pageIds?: string | string[],
    @Body('firstComment') firstComment?: string,
    @Body('commentPageIds') commentPageIds?: string | string[],
  ) {
    return this.postsService.publishFeed({
      userId: authUser.userId,
      caption: typeof caption === 'string' ? caption : '',
      pageIds: this.pageIds(pageIds),
      files: files ?? [],
      firstComment: typeof firstComment === 'string' ? firstComment : '',
      commentPageIds: this.optionalIds(commentPageIds),
    });
  }

  private pageIds(value: string | string[] | undefined): string[] {
    const ids = this.optionalIds(value);
    if (ids.length === 0) {
      throw new BadRequestException('Select at least one connected Facebook Page.');
    }
    return ids;
  }

  private optionalIds(value: string | string[] | undefined): string[] {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
