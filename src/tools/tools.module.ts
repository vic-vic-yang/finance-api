import { Module } from '@nestjs/common';
import { ToolsController } from './tools.controller';
import { ExchangeService } from './exchange.service';

@Module({
  controllers: [ToolsController],
  providers: [ExchangeService],
})
export class ToolsModule {}
