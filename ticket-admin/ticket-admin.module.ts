import { Module } from '@nestjs/common';
import { TicketAdminController } from './ticket-admin.controller';
import { TicketAdminService } from './ticket-admin.service';
import { TicketAutoCloseService } from './ticket-auto-close.service';
import { PrismaService } from '../../prisma.service';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [TicketAdminController],
  providers: [TicketAdminService, TicketAutoCloseService, PrismaService],
  exports: [TicketAdminService],
})
export class TicketAdminModule {}