import {
  Controller, Get, Query, Request, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BriefingService } from './briefing.service';
import { QueryBriefingDto } from './dto/query-briefing.dto';

/** 每周管家简报查询接口（JWT + 账本成员校验，service 内 ensureMembership）
 *  - GET /api/briefings/latest?ledgerId=   最新一份（无则 briefing=null）
 *  - GET /api/briefings?ledgerId=&page=    历史列表，新周在前
 */
@Controller('briefings')
@UseGuards(AuthGuard('jwt'))
export class BriefingController {
  constructor(private svc: BriefingService) {}

  @Get('latest')
  latest(@Request() req, @Query() q: QueryBriefingDto) {
    return this.svc.latest(req.user.id, q.ledgerId);
  }

  @Get()
  list(@Request() req, @Query() q: QueryBriefingDto) {
    return this.svc.list(req.user.id, q.ledgerId, q.page ?? 1);
  }
}
