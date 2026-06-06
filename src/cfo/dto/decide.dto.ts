import { IsIn } from 'class-validator';

export class DecideDto {
  @IsIn(['approve', 'dismiss', 'snooze', 'resolve'])
  action: 'approve' | 'dismiss' | 'snooze' | 'resolve';
}
