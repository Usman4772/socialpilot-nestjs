import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true })
export class LoginSession {
  @Prop({ type: String, ref: 'User', required: true, index: true })
  userId: string;

  @Prop({ required: true, unique: true, index: true })
  sessionHash: string;

  @Prop({ type: Date, required: true, index: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  usedAt?: Date | null;

  createdAt: Date;

  updatedAt: Date;
}

export type LoginSessionDocument = HydratedDocument<LoginSession>;
export const LoginSessionSchema = SchemaFactory.createForClass(LoginSession);
