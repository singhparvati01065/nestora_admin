import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

// hbs exports its helpers on module.exports; a namespace import loses them
// under this project's TS interop settings, so require it directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hbs = require('hbs');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(cookieParser());

  app.setViewEngine('hbs');
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  hbs.registerPartials(join(__dirname, '..', 'views', 'admin', 'partials'));
  hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hbs.registerHelper('json', (o: unknown) => JSON.stringify(o));
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    prefix: '/admin-assets',
  });

  // Root → the panel.
  app.getHttpAdapter().get('/', (_req: any, res: any) => res.redirect('/admin'));

  const port = app.get(ConfigService).get<number>('PORT') ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Nestora Admin panel running at http://localhost:${port}/admin`);
}
bootstrap();
