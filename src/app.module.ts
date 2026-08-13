import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminController } from './admin/admin.controller';
import { AdminAuthMiddleware } from './admin/admin-auth.middleware';
import { CsrfMiddleware } from './admin/csrf.middleware';
import { LoginThrottle } from './admin/login-throttle';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [PrismaService, LoginThrottle],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Form-token check first, so it also covers the login POST.
    consumer.apply(CsrfMiddleware).forRoutes(AdminController);
    // Every /admin page needs a session, except the login form itself.
    consumer
      .apply(AdminAuthMiddleware)
      .exclude(
        { path: 'admin/login', method: RequestMethod.GET },
        { path: 'admin/login', method: RequestMethod.POST },
      )
      .forRoutes(AdminController);
  }
}
