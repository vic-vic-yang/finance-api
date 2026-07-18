import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * AdminGuard：仅允许 role='admin' 的用户访问。
 * 需在 JWT 验证之后使用（先 @UseGuards(AuthGuard('jwt'))）。
 *
 * JwtStrategy.validate() 返回完整的 user 对象（含 role 字段），
 * 所以这里直接检查 req.user.role。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('需要管理员权限');
    }
    return true;
  }
}
