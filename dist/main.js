"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = require("path");
const core_1 = require("@nestjs/core");
const config_1 = require("@nestjs/config");
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const app_module_1 = require("./app.module");
const hbs = require('hbs');
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    app.use((0, cookie_parser_1.default)());
    app.setViewEngine('hbs');
    app.setBaseViewsDir((0, path_1.join)(__dirname, '..', 'views'));
    hbs.registerPartials((0, path_1.join)(__dirname, '..', 'views', 'admin', 'partials'));
    hbs.registerHelper('eq', (a, b) => a === b);
    hbs.registerHelper('json', (o) => JSON.stringify(o));
    app.useStaticAssets((0, path_1.join)(__dirname, '..', 'public'), {
        prefix: '/admin-assets',
    });
    app.getHttpAdapter().get('/', (_req, res) => res.redirect('/admin'));
    const port = app.get(config_1.ConfigService).get('PORT') ?? 4000;
    await app.listen(port);
    console.log(`Nestora Admin panel running at http://localhost:${port}/admin`);
}
bootstrap();
//# sourceMappingURL=main.js.map