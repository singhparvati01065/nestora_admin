import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';

const COOKIE = 'admin_csrf';
const FIELD = '_csrf';

/// Double-submit CSRF protection for the panel's forms.
///
/// The panel authenticates with a cookie, so without this any page on the
/// internet could POST to it on a logged-in super-admin's behalf — banning
/// users or deleting a society. Every request carries a random token in a
/// cookie; every form echoes the same token back in a hidden field, which a
/// cross-site page cannot read.
///
/// Runs before the auth middleware so the login form is protected too.
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const cookies = (req as any).cookies ?? {};
    let token = cookies[COOKIE] as string | undefined;

    if (!token) {
      token = randomBytes(32).toString('hex');
      res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    }

    // Handlebars reads this in every view; express merges res.locals into the
    // render context.
    res.locals.csrf = token;

    if (req.method === 'POST') {
      const sent = (req.body ?? {})[FIELD] as string | undefined;
      if (!sent || sent !== token) {
        throw new ForbiddenException('Invalid or expired form token');
      }
    }
    next();
  }
}
