import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AuthUserResponse } from '../auth/auth.types';
import { User, UserDocument } from './schemas/user.schema';

export type GoogleProfileInput = {
  googleId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  pictureUrl: string | null;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async findById(id: string): Promise<UserDocument | null> {
    if (!id) {
      return null;
    }
    return this.userModel.findOne({ _id: id, isDeleted: false }).exec();
  }

  toAuthUser(user: UserDocument): AuthUserResponse {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      pictureUrl: user.googlePictureUrl?.trim() || null,
    };
  }

  async upsertFromGoogle(profile: GoogleProfileInput): Promise<UserDocument> {
    const googleId = profile.googleId.trim();
    const email = profile.email.trim().toLowerCase();
    const pictureUrl = profile.pictureUrl?.trim() || null;

    const byGoogle = await this.userModel.findOne({ googleId, isDeleted: false }).exec();
    if (byGoogle) {
      return this.applyProfile(byGoogle, profile, pictureUrl);
    }

    const byEmail = await this.userModel.findOne({ email, isDeleted: false }).exec();
    if (byEmail) {
      if (byEmail.googleId && byEmail.googleId !== googleId) {
        throw new UnauthorizedException(
          'This email is already linked to a different Google account',
        );
      }
      byEmail.googleId = googleId;
      return this.applyProfile(byEmail, profile, pictureUrl);
    }

    const restored = await this.userModel
      .findOne({
        isDeleted: true,
        $or: [{ googleId }, { email }],
      })
      .exec();
    if (restored) {
      restored.isDeleted = false;
      restored.deletedAt = null;
      restored.googleId = googleId;
      restored.email = email;
      return this.applyProfile(restored, profile, pictureUrl);
    }

    try {
      const created = await this.userModel.create({
        username: await this.uniqueUsername(email),
        email,
        googleId,
        firstName: profile.firstName,
        lastName: profile.lastName,
        googlePictureUrl: pictureUrl,
        emailVerified: true,
        isDeleted: false,
      });
      return created;
    } catch (err) {
      if (!this.isDuplicateKey(err)) {
        throw err;
      }
      const raced =
        (await this.userModel.findOne({ googleId, isDeleted: false }).exec()) ||
        (await this.userModel.findOne({ email, isDeleted: false }).exec());
      if (!raced) {
        throw err;
      }
      if (!raced.googleId) {
        raced.googleId = googleId;
      }
      return this.applyProfile(raced, profile, pictureUrl);
    }
  }

  private async applyProfile(
    user: UserDocument,
    profile: GoogleProfileInput,
    pictureUrl: string | null,
  ): Promise<UserDocument> {
    if (profile.firstName) {
      user.firstName = profile.firstName;
    }
    if (profile.lastName) {
      user.lastName = profile.lastName;
    }
    if (pictureUrl) {
      user.googlePictureUrl = pictureUrl;
    }
    user.emailVerified = true;
    await user.save();
    return user;
  }

  private async uniqueUsername(email: string): Promise<string> {
    const local = email.split('@')[0] ?? 'user';
    const base = (local.replace(/[^a-z0-9._-]/gi, '').slice(0, 24) || 'user').toLowerCase();
    let candidate = base;
    let suffix = 0;
    while (await this.userModel.exists({ username: candidate })) {
      suffix += 1;
      candidate = `${base}${suffix}`;
    }
    return candidate;
  }

  private isDuplicateKey(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    );
  }
}
