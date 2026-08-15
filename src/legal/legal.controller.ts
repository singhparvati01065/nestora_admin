import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma.service';

/// The pages Play (and anyone else) has to be able to read without an account.
///
/// The app shows the same text from the same rows, so there is one copy to
/// keep current: edit it under CMS and both move together. Deliberately
/// outside AdminController, so neither the session guard nor the CSRF check
/// applies here.
@Controller('legal')
export class LegalController {
  constructor(private prisma: PrismaService) {}

  private static readonly PUBLIC_KEYS = ['privacy', 'terms', 'faq', 'about', 'contact'];

  @Get(':key')
  async page(@Param('key') key: string, @Res() res: Response) {
    if (!LegalController.PUBLIC_KEYS.includes(key)) {
      return res.status(404).send('Not found');
    }
    const page = await this.prisma.contentPage.findUnique({ where: { key } });
    if (!page) return res.status(404).send('Not found');

    res.type('html').send(LegalController.render(page.title, page.body));
  }

  /// Plain text in, readable page out, matching how the app lays the same
  /// text out: blank lines separate blocks, a short line with no punctuation
  /// starts a section, and "- " lines are bullets.
  private static render(title: string, body: string): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // "2. What we collect" is a heading; the number's own full stop does not
    // count against it, the rest of the line's punctuation does.
    const isHeading = (line: string) => {
      const rest = line.replace(/^\d+[.)]\s*/, '');
      return rest.length > 0 && line.length < 70 && !/[.:;,?]/.test(rest);
    };

    const blocks = body
      .replace(/\r\n/g, '\n')
      .trim()
      .split(/\n\s*\n/)
      .map((block) => {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) return '';
        // The body repeats the page title on its first line; the <h1> above
        // already says it.
        if (lines.length === 1 && lines[0] === title) return '';

        if (lines.every((l) => l.startsWith('- '))) {
          return `<ul>${lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join('')}</ul>`;
        }
        // "2. What we collect" on its own line, then the paragraph under it.
        if (lines.length > 1 && isHeading(lines[0])) {
          return `<h2>${esc(lines[0])}</h2><p>${esc(lines.slice(1).join(' '))}</p>`;
        }
        if (lines.length === 1 && isHeading(lines[0])) {
          return `<h2>${esc(lines[0])}</h2>`;
        }
        return `<p>${esc(lines.join(' '))}</p>`;
      })
      .filter(Boolean)
      .join('\n');

    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} · Nestora</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; background: #f7f6fb; color: #1c1b1f;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 64px; }
  header { background: #6C4AB6; color: #fff; padding: 22px 20px; }
  header div { max-width: 720px; margin: 0 auto; font-weight: 600; font-size: 18px; }
  h1 { font-size: 26px; margin: 24px 0 4px; }
  h2 { font-size: 18px; margin: 28px 0 6px; }
  p, li { color: #3b3946; }
  ul { padding-left: 20px; }
  footer { max-width: 720px; margin: 0 auto; padding: 0 20px 48px; color: #6b6980; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    body { background: #141318; color: #e7e0ec; }
    p, li { color: #cdc7d5; }
    footer { color: #9a95a8; }
  }
</style>
</head><body>
<header><div>Nestora</div></header>
<main>
<h1>${esc(title)}</h1>
${blocks}
</main>
<footer>Nestora · society management</footer>
</body></html>`;
  }
}
