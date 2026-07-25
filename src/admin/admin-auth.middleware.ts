import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';

/// Gate for the super-admin panel: needs a valid `admin_session` cookie (a JWT
/// for a SUPER_ADMIN). Missing / invalid → redirect to the login page.
@Injectable()
export class AdminAuthMiddleware implements NestMiddleware {
  constructor(private jwt: JwtService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const token = (req as any).cookies?.admin_session as string | undefined;
    if (token) {
      try {
        const payload = this.jwt.verify(token) as { role?: string };
        if (payload.role === Role.SUPER_ADMIN) {
          (req as any).admin = payload;
          return next();
        }
      } catch {
        // fall through
      }
    }
    res.redirect('/admin/login');
  }
}
