import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { UsersModule } from '../users/users.module';
import { CloudinaryService } from './cloudinary.service';
import { FacebookPublishService } from './facebook-publish.service';
import { InstagramPublishService } from './instagram-publish.service';
import { LinkedInPublishService } from './linkedin-publish.service';
import { PostScheduleService } from './post-schedule.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { Post, PostSchema } from './schemas/post.schema';

@Module({
  imports: [
    UsersModule,
    ConnectedAccountsModule,
    MongooseModule.forFeature([{ name: Post.name, schema: PostSchema }]),
  ],
  controllers: [PostsController],
  providers: [PostsService, CloudinaryService, FacebookPublishService, InstagramPublishService, LinkedInPublishService, PostScheduleService],
})
export class PostsModule {}
