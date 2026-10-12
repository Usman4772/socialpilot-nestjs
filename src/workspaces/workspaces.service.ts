import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../users/schemas/user.schema';
import { Workspace, WorkspaceDocument } from './schemas/workspace.schema';

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<WorkspaceDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async ensureForUser(user: UserDocument): Promise<WorkspaceDocument> {
    const existing = user.workspaces?.find((membership) => membership.status === 'active');
    if (existing) {
      const workspace = await this.workspaceModel.findById(existing.workspaceId).exec();
      if (workspace && workspace.status === 'active') {
        return workspace;
      }
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    const workspace = await this.workspaceModel.create({
      name: name ? `${name}'s workspace` : 'My workspace',
      userId: user.id,
      timezone: 'UTC',
      status: 'active',
    });

    user.workspaces = [
      ...(user.workspaces ?? []).map((membership) => ({
        ...membership,
        isDefault: false,
      })),
      {
        workspaceId: workspace.id,
        role: 'owner' as const,
        status: 'active' as const,
        isDefault: true,
        joinedAt: new Date(),
      },
    ];
    await user.save();
    return workspace;
  }
}
