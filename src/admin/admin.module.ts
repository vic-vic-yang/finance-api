import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { GithubActionsClient } from './releases/github-actions.client';
import { ReleasesController } from './releases/releases.controller';
import { ReleasesService } from './releases/releases.service';

@Module({
  controllers: [AdminController, ReleasesController],
  providers: [AdminService, ReleasesService, GithubActionsClient],
})
export class AdminModule {}
