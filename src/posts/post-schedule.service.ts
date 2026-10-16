import { BadRequestException, forwardRef, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Model } from 'mongoose';

import { PostsService } from './posts.service';
import { Post, PostDocument } from './schemas/post.schema';

const QUEUE_NAME = 'post-publish';


type PublishJob = { postId: string };

@Injectable()
export class PostScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostScheduleService.name);
  private queue?: Queue<PublishJob>;
  private worker?: Worker<PublishJob>;
  private connections: IORedis[] = [];
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(Post.name) private readonly postModel: Model<PostDocument>,
    @Inject(forwardRef(() => PostsService)) private readonly postsService: PostsService,
  ) {}

  onModuleInit() {
    const url = this.configService.get<string>('REDIS_URL') || 'redis://127.0.0.1:6379';
    const queueConnection = this.redis(url);
    const workerConnection = this.redis(url);
    this.queue = new Queue<PublishJob>(QUEUE_NAME, { connection: queueConnection });
    this.worker = new Worker<PublishJob>(QUEUE_NAME, (job) => this.publish(job), {
      connection: workerConnection,
      settings: {
        backoffStrategy: (attemptsMade: number) => [60_000, 5 * 60_000, 15 * 60_000][attemptsMade - 1] ?? 15 * 60_000,
      },
    });
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError;
      if (!exhausted) return;
      void this.postsService.finishFailedSchedule(job.data.postId).catch((finishError: unknown) => {
        this.logger.warn(finishError instanceof Error ? finishError.message : 'Could not record the failed schedule');
      });
    });
    this.worker.on('error', (err) => this.logger.warn(err.message));
    this.queue.on('error', (err) => this.logger.warn(err.message));
    this.logger.log('Publish queue is ready');
    this.recoveryTimer = setInterval(() => {
      void this.recover().catch((err: unknown) => {
        this.logger.warn(err instanceof Error ? err.message : 'Schedule recovery failed');
      });
    }, 60_000);
    void this.recover();
  }

  async onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((connection) => connection.quit().catch(() => undefined)));
  }

  async enqueue(postId: string, runAt: Date, replace = false): Promise<void> {
    if (!this.queue) throw new BadRequestException('Could not schedule that post. Please try again.');
    const jobId = this.jobId(postId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active') {
        if (replace) throw new BadRequestException('That post is already being published.');
        return;
      }
      if (!replace && (state === 'waiting' || state === 'delayed')) return;
      await existing.remove();
    }
    const delay = Math.max(0, runAt.getTime() - Date.now());
    await this.queue.add(
      'publish',
      { postId },
      {
        jobId,
        delay,
        attempts: 4,
        backoff: { type: 'custom' },
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
      },
    );
  }

  async remove(postId: string): Promise<void> {
    if (!this.queue) return;
    const existing = await this.queue.getJob(this.jobId(postId));
    if (!existing) return;
    const state = await existing.getState();
    if (state === 'active') return;
    await existing.remove();
  }

  private async publish(job: Job<PublishJob>) {
    try {
      await this.postsService.publishDue(job.data.postId, job.attemptsMade);
    } catch (err) {
      if (!isRetryablePublishError(err)) {
        await this.postsService.finishFailedSchedule(job.data.postId);
        throw new UnrecoverableError(err instanceof Error ? err.message : 'Facebook did not publish the post');
      }
      throw err;
    }
  }

  private redis(url: string) {
    const connection = new IORedis(url, { maxRetriesPerRequest: null });
    connection.on('error', (err: Error) => this.logger.warn(err.message));
    this.connections.push(connection);
    return connection;
  }

  private async recover() {
    if (!this.queue) return;
    const due = await this.postModel
      .find({ status: 'scheduled', scheduledAt: { $lte: new Date() } })
      .select('_id scheduledAt')
      .limit(50)
      .exec();
    for (const post of due) {
      const existing = await this.queue.getJob(this.jobId(post.id));
      const state = existing ? await existing.getState() : null;
      if (state === 'active' || state === 'waiting' || state === 'delayed') continue;
      await this.enqueue(post.id, post.scheduledAt ?? new Date());
    }
  }

  private jobId(postId: string) {
    return `publish-${postId}`;
  }

}

export function isRetryablePublishError(err: unknown): boolean {
  const status = typeof err === 'object' && err && 'status' in err ? Number(err.status) : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (status !== undefined && status >= 400) return false;
  const code = typeof err === 'object' && err && 'code' in err ? Number(err.code) : undefined;
  if (code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613) return true;
  if (code === 10 || code === 100 || code === 190 || code === 200 || (code !== undefined && code >= 1363000)) return false;
  const message = err instanceof Error ? err.message : '';
  return /timeout|fetch failed|ECONN|ETIMEDOUT|network|tried again/i.test(message);
}
