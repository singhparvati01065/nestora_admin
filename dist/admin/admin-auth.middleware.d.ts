import { NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { NextFunction, Request, Response } from 'express';
export declare class AdminAuthMiddleware implements NestMiddleware {
    private jwt;
    constructor(jwt: JwtService);
    use(req: Request, res: Response, next: NextFunction): void;
}
