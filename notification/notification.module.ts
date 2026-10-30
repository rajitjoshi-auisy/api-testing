import { Module } from '@nestjs/common';
import { NotificationQueue } from './notification.queue';

@Module({
  providers: [NotificationQueue],
  exports: [NotificationQueue],
})
export class NotificationModule {}
