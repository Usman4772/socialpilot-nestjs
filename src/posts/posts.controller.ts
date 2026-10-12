import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { FacebookPostType } from './schemas/post.schema';

const upload = FilesInterceptor('files', 10, {
  limits: { fileSize: 100 * 1024 * 1024, files: 10 },
});

@ApiTags('Posts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get('drafts')
  drafts(@CurrentUser() authUser: JwtAuthUser) {
    return this.postsService.listDrafts(authUser.userId);
  }

  @Post('drafts')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(upload)
  saveDraft(
    @CurrentUser() authUser: JwtAuthUser,
    @UploadedFiles() files: UploadableFile[] | undefined,
    @Body('caption') caption?: string,
    @Body('pageIds') pageIds?: string | string[],
    @Body('firstComment') firstComment?: string,
    @Body('postType') postType?: string,
    @Body('videoTitle') videoTitle?: string,
    @Body('aiGenerated') aiGenerated?: string,
    @Body('draftId') draftId?: string,
    @Body('keepPublicIds') keepPublicIds?: string | string[],
  ) {
    return this.postsService.saveDraft({
      userId: authUser.userId,
      draftId: draftId?.trim() || undefined,
      caption: typeof caption === 'string' ? caption : '',
      pageIds: this.optionalIds(pageIds),
      files: files ?? [],
      keepPublicIds: this.optionalIds(keepPublicIds),
      postType: this.postType(postType),
      videoTitle: typeof videoTitle === 'string' ? videoTitle : '',
      aiGenerated: this.aiFlag(aiGenerated),
      firstComment: typeof firstComment === 'string' ? firstComment : '',
    });
  }

  @Get(':id')
  draft(@CurrentUser() authUser: JwtAuthUser, @Param('id') id: string) {
    return this.postsService.getDraft(authUser.userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeDraft(@CurrentUser() authUser: JwtAuthUser, @Param('id') id: string) {
    return this.postsService.deleteDraft(authUser.userId, id);
  }

  @Post('schedule')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(upload)
  schedule(
    @CurrentUser() authUser: JwtAuthUser,
    @UploadedFiles() files: UploadableFile[] | undefined,
    @Body('caption') caption?: string,
    @Body('pageIds') pageIds?: string | string[],
    @Body('firstComment') firstComment?: string,
    @Body('commentPageIds') commentPageIds?: string | string[],
    @Body('postType') postType?: string,
    @Body('videoTitle') videoTitle?: string,
    @Body('aiGenerated') aiGenerated?: string,
    @Body('draftId') draftId?: string,
    @Body('keepPublicIds') keepPublicIds?: string | string[],
    @Body('scheduledAt') scheduledAt?: string,
    @Body('timezone') timezone?: string,
  ) {
    if (!scheduledAt) throw new BadRequestException('Pick a time in the future.');
    return this.postsService.schedule({
      userId: authUser.userId,
      caption: typeof caption === 'string' ? caption : '',
      pageIds: this.pageIds(pageIds),
      files: files ?? [],
      keepPublicIds: this.optionalIds(keepPublicIds),
      draftId: draftId?.trim() || undefined,
      postType: this.postType(postType),
      videoTitle: typeof videoTitle === 'string' ? videoTitle : '',
      aiGenerated: this.aiFlag(aiGenerated),
      firstComment: typeof firstComment === 'string' ? firstComment : '',
      commentPageIds: this.optionalIds(commentPageIds),
      scheduledAt,
      timezone,
    });
  }

  @Patch(':id/schedule')
  reschedule(
    @CurrentUser() authUser: JwtAuthUser,
    @Param('id') id: string,
    @Body('scheduledAt') scheduledAt?: string,
    @Body('timezone') timezone?: string,
  ) {
    if (!scheduledAt) throw new BadRequestException('Pick a time in the future.');
    return this.postsService.reschedule(authUser.userId, id, scheduledAt, timezone);
  }

  @Delete(':id/schedule')
  cancelSchedule(@CurrentUser() authUser: JwtAuthUser, @Param('id') id: string) {
    return this.postsService.cancelSchedule(authUser.userId, id);
  }

  @Post('publish')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(upload)
  publish(
    @CurrentUser() authUser: JwtAuthUser,
    @UploadedFiles() files: UploadableFile[] | undefined,
    @Body('caption') caption?: string,
    @Body('pageIds') pageIds?: string | string[],
    @Body('firstComment') firstComment?: string,
    @Body('commentPageIds') commentPageIds?: string | string[],
    @Body('postType') postType?: string,
    @Body('videoTitle') videoTitle?: string,
    @Body('aiGenerated') aiGenerated?: string,
    @Body('draftId') draftId?: string,
    @Body('keepPublicIds') keepPublicIds?: string | string[],
  ) {
    return this.postsService.publishFeed({
      userId: authUser.userId,
      caption: typeof caption === 'string' ? caption : '',
      pageIds: this.pageIds(pageIds),
      files: files ?? [],
      keepPublicIds: this.optionalIds(keepPublicIds),
      draftId: draftId?.trim() || undefined,
      postType: this.postType(postType),
      videoTitle: typeof videoTitle === 'string' ? videoTitle : '',
      aiGenerated: this.aiFlag(aiGenerated),
      firstComment: typeof firstComment === 'string' ? firstComment : '',
      commentPageIds: this.optionalIds(commentPageIds),
    });
  }

  private postType(value: string | undefined): FacebookPostType {
    if (value === 'story' || value === 'carousel' || value === 'feed' || value === 'reel') return value;
    if (!value) return 'feed';
    throw new BadRequestException('Choose Feed, Reel, Story, or Carousel.');
  }

  private aiFlag(value: string | undefined): boolean | null {
    if (value === 'yes') return true;
    if (value === 'no') return false;
    return null;
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
