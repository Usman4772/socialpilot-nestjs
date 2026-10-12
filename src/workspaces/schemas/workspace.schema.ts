import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'workspaces' })
export class Workspace {
  @Prop({ required: true, trim: true })
  name: string;

  /** Social Hub user who created the workspace. */
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ default: 'UTC', trim: true })
  timezone: string;

  @Prop({ required: true, enum: ['active', 'suspended'], default: 'active' })
  status: 'active' | 'suspended';

  createdAt: Date;

  updatedAt: Date;
}

export type WorkspaceDocument = HydratedDocument<Workspace>;
export const WorkspaceSchema = SchemaFactory.createForClass(Workspace);
