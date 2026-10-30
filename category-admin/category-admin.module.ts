import { Module } from '@nestjs/common';
import { CategoryAdminController } from './category-admin.controller';
import { CategoryAdminService } from './category-admin.service';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [CategoryAdminController],
  providers: [CategoryAdminService, PrismaService],
  exports: [CategoryAdminService],
})
export class CategoryAdminModule {}
