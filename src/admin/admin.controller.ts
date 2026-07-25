import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, SubscriptionPlan } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma.service';

const DAY = 24 * 60 * 60 * 1000;

const PLAN_LABELS: Record<string, string> = {
  FREE: 'Free',
  PREMIUM_MONTHLY: 'Premium · Monthly',
  PREMIUM_YEARLY: 'Premium · Yearly',
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

@Controller('admin')
export class AdminController {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  private apiBase(): string {
    return this.config.get<string>('API_BASE') ?? 'http://localhost:3000';
  }

  private logoUrl(path: string | null): string | null {
    return path ? this.apiBase() + path : null;
  }

  private actor(req: Request): string {
    return ((req as any).admin?.name as string) ?? 'Super Admin';
  }

  private log(req: Request, action: string, detail: string) {
    return this.prisma.auditLog
      .create({ data: { action, detail, actor: this.actor(req) } })
      .catch(() => null);
  }

  // ---- Auth ----

  @Get('login')
  loginPage(@Query('error') error: string, @Res() res: Response) {
    res.render('admin/login', { error: !!error });
  }

  @Post('login')
  async login(
    @Body() body: { email?: string; password?: string },
    @Res() res: Response,
  ) {
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok =
      user &&
      user.role === Role.SUPER_ADMIN &&
      user.password &&
      (await bcrypt.compare(password, user.password));
    if (!ok) return res.redirect('/admin/login?error=1');
    const token = this.jwtService.sign({
      sub: user!.id,
      name: user!.name,
      role: user!.role,
    });
    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * DAY,
    });
    res.redirect('/admin');
  }

  @Get('logout')
  logout(@Res() res: Response) {
    res.clearCookie('admin_session');
    res.redirect('/admin/login');
  }

  // ---- Dashboard ----

  @Get()
  async dashboard(@Res() res: Response) {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * DAY);
    const twoWeeks = new Date(now.getTime() - 13 * DAY);

    const [
      totalSocieties,
      activeSocieties,
      inactiveSocieties,
      totalResidents,
      totalAdmins,
      totalGuards,
      totalMaint,
      totalVisitors,
      totalComplaints,
      newRegistrations,
      revenueAgg,
      maintenanceAgg,
      allSoc,
      paidBills,
      logins,
      recent,
    ] = await Promise.all([
      this.prisma.society.count(),
      this.prisma.society.count({ where: { suspended: false } }),
      this.prisma.society.count({ where: { suspended: true } }),
      this.prisma.resident.count({ where: { archivedAt: null } }),
      this.prisma.user.count({ where: { role: Role.SOCIETY_ADMIN } }),
      this.prisma.user.count({ where: { role: Role.SECURITY_GUARD } }),
      this.prisma.user.count({ where: { role: Role.MAINTENANCE_STAFF } }),
      this.prisma.visitor.count(),
      this.prisma.complaint.count(),
      this.prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null },
      }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null, kind: 'MANUAL' },
      }),
      this.prisma.society.findMany({ select: { createdAt: true } }),
      this.prisma.bill.findMany({
        where: { paid: true, deletedAt: null, paidAt: { not: null } },
        select: { paidAt: true, amount: true },
      }),
      this.prisma.loginEvent.findMany({
        where: { createdAt: { gte: twoWeeks } },
        select: { createdAt: true },
      }),
      this.prisma.society.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { _count: { select: { flats: true, users: true } } },
      }),
    ]);

    const totalRevenue = Math.round(Number(revenueAgg._sum.amount ?? 0));
    const totalMaintenance = Math.round(
      Number(maintenanceAgg._sum.amount ?? 0),
    );

    // 6-month buckets for society growth + monthly revenue.
    const months: { label: string; societies: number; revenue: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
        societies: 0,
        revenue: 0,
      });
    }
    const monthKey = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    for (const s of allSoc) {
      const m = months.find((x) => x.label === monthKey(s.createdAt));
      if (m) m.societies++;
    }
    for (const b of paidBills) {
      if (!b.paidAt) continue;
      const m = months.find((x) => x.label === monthKey(b.paidAt!));
      if (m) m.revenue += Number(b.amount);
    }

    // 14-day buckets for login analytics.
    const days: { label: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY);
      days.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, count: 0 });
    }
    for (const l of logins) {
      const d = l.createdAt;
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      const day = days.find((x) => x.label === label);
      if (day) day.count++;
    }

    res.render('admin/dashboard', {
      page: 'dashboard',
      stats: {
        totalSocieties,
        activeSocieties,
        inactiveSocieties,
        totalResidents,
        totalAdmins,
        totalGuards,
        totalVisitors,
        totalComplaints,
        totalRevenue,
        totalMaintenance,
        newRegistrations,
      },
      growth: {
        labels: months.map((m) => m.label),
        data: months.map((m) => m.societies),
      },
      revenue: {
        labels: months.map((m) => m.label),
        data: months.map((m) => Math.round(m.revenue)),
      },
      activeUsers: {
        labels: ['Residents', 'Admins', 'Guards', 'Maintenance'],
        data: [totalResidents, totalAdmins, totalGuards, totalMaint],
      },
      loginAnalytics: {
        labels: days.map((d) => d.label),
        data: days.map((d) => d.count),
      },
      recent: recent.map((s) => ({
        id: s.id,
        name: s.name,
        flats: s._count.flats,
        users: s._count.users,
        plan: PLAN_LABELS[s.plan],
        suspended: s.suspended,
      })),
    });
  }

  // ---- Societies ----

  @Get('societies')
  async societies(@Res() res: Response) {
    const rows = await this.prisma.society.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        users: {
          where: { role: Role.SOCIETY_ADMIN },
          select: { name: true, phone: true },
          take: 1,
        },
      },
    });
    res.render('admin/societies', {
      page: 'societies',
      societies: rows.map((s) => ({
        id: s.id,
        name: s.name,
        logo: this.logoUrl(s.logoUrl),
        initial: s.name.charAt(0).toUpperCase(),
        city: s.city ?? '—',
        state: s.state ?? '—',
        adminName: s.users[0]?.name ?? '—',
        contact: s.users[0]?.phone ?? '—',
        plan: PLAN_LABELS[s.plan],
        isFree: s.plan === 'FREE',
        suspended: s.suspended,
        created: s.createdAt.toDateString(),
      })),
    });
  }

  /// Impersonation: mint a real API token for the society's admin, signed with
  /// the MAIN backend's secret so it works against the app's API. Shown on a
  /// page for support/debugging (the app is mobile, so there's no web session).
  @Post('societies/:id/impersonate')
  async impersonate(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const admin = await this.prisma.user.findFirst({
      where: { societyId: id, role: Role.SOCIETY_ADMIN },
    });
    const society = await this.prisma.society.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!admin || !society) return res.redirect('/admin/societies');

    const payload = {
      sub: admin.id,
      phone: admin.phone,
      name: admin.name,
      photoUrl: admin.photoUrl,
      role: admin.role,
      societyId: admin.societyId,
      flatId: admin.flatId,
      staffLabel: admin.staffLabel,
      trades: admin.trades,
    };
    const secret =
      this.config.get<string>('API_JWT_SECRET') ?? 'dev-secret';
    const token = jwt.sign(payload, secret, { expiresIn: '1h' });
    await this.log(req, 'Impersonate', `${society.name} (${admin.name})`);

    res.render('admin/impersonate', {
      page: 'societies',
      societyName: society.name,
      adminName: admin.name,
      token,
      apiBase: this.apiBase(),
    });
  }

  @Get('societies/:id')
  async society(@Param('id') id: string, @Res() res: Response) {
    const s = await this.prisma.society.findUnique({
      where: { id },
      include: {
        _count: { select: { flats: true } },
        users: {
          where: { role: Role.SOCIETY_ADMIN },
          select: { name: true, phone: true },
        },
      },
    });
    if (!s) return res.redirect('/admin/societies');

    const [residents, bills, complaints] = await Promise.all([
      this.prisma.resident.findMany({
        where: { societyId: id, archivedAt: null },
        include: { flat: { select: { number: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.bill.findMany({
        where: { societyId: id, deletedAt: null },
        include: { flat: { select: { number: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.complaint.findMany({
        where: { societyId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    res.render('admin/society', {
      page: 'societies',
      s: {
        id: s.id,
        name: s.name,
        address: s.address,
        city: s.city ?? '',
        state: s.state ?? '',
        flats: s._count.flats,
        plan: PLAN_LABELS[s.plan],
        suspended: s.suspended,
        created: s.createdAt.toDateString(),
        admins: s.users,
      },
      residents: residents.map((r) => ({
        name: r.name,
        flat: r.flat?.number ?? '—',
        type: r.type,
        phone: r.phone ?? '—',
      })),
      bills: bills.map((b) => ({
        flat: b.flat?.number ?? '—',
        kind: b.kind,
        amount: Number(b.amount).toFixed(0),
        paid: b.paid,
      })),
      complaints: complaints.map((c) => ({
        title: c.title,
        category: c.category,
        status: c.status,
      })),
    });
  }

  @Post('societies/:id/edit')
  async editSociety(
    @Param('id') id: string,
    @Body()
    body: { name?: string; address?: string; city?: string; state?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const name = (body.name ?? '').trim();
    const address = (body.address ?? '').trim();
    if (name && address) {
      await this.prisma.society.update({
        where: { id },
        data: {
          name,
          address,
          city: (body.city ?? '').trim() || null,
          state: (body.state ?? '').trim() || null,
        },
      });
      await this.log(req, 'Edit society', name);
    }
    res.redirect('/admin/societies/' + id);
  }

  @Post('societies/:id/suspend')
  async toggleSuspend(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const s = await this.prisma.society.findUnique({
      where: { id },
      select: { suspended: true, name: true },
    });
    if (s) {
      await this.prisma.society.update({
        where: { id },
        data: { suspended: !s.suspended },
      });
      await this.log(
        req,
        s.suspended ? 'Un-suspend society' : 'Suspend society',
        s.name,
      );
    }
    res.redirect('/admin/societies/' + id);
  }

  @Post('societies/:id/delete')
  async deleteSociety(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const s = await this.prisma.society.findUnique({
      where: { id },
      select: { name: true },
    });
    await this.prisma.society.delete({ where: { id } }).catch(() => null);
    if (s) await this.log(req, 'Delete society', s.name);
    res.redirect('/admin/societies');
  }

  // ---- Users ----

  @Get('users')
  async users(@Query('q') q: string, @Res() res: Response) {
    const query = (q ?? '').trim();
    const rows = await this.prisma.user.findMany({
      where: query
        ? {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { phone: { contains: query } },
            ],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { society: { select: { name: true } } },
    });
    res.render('admin/users', {
      page: 'users',
      q: query,
      users: rows.map((u) => ({
        id: u.id,
        name: u.name,
        phone: u.phone,
        role: u.role.replace('_', ' '),
        society: u.society?.name ?? '—',
        banned: u.banned,
      })),
    });
  }

  @Post('users/:id/ban')
  async toggleBan(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: { banned: true, name: true },
    });
    if (u) {
      await this.prisma.user.update({
        where: { id },
        data: { banned: !u.banned },
      });
      await this.log(req, u.banned ? 'Unban user' : 'Ban user', u.name);
    }
    res.redirect('/admin/users');
  }

  // ---- Super admins ----

  @Get('admins')
  async admins(@Res() res: Response) {
    const rows = await this.prisma.user.findMany({
      where: { role: Role.SUPER_ADMIN },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true },
    });
    res.render('admin/admins', { page: 'admins', admins: rows });
  }

  @Post('admins')
  async addAdmin(
    @Body() body: { name?: string; email?: string; password?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const name = (body.name ?? '').trim();
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    if (name && email && password.length >= 4) {
      const hash = await bcrypt.hash(password, 10);
      // Super admins have no phone in the app; store a unique placeholder.
      const phone = 'sa_' + Date.now();
      await this.prisma.user
        .create({
          data: { name, email, password: hash, phone, role: Role.SUPER_ADMIN },
        })
        .catch(() => null);
      await this.log(req, 'Add super-admin', email);
    }
    res.redirect('/admin/admins');
  }

  @Post('admins/:id/delete')
  async removeAdmin(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const count = await this.prisma.user.count({
      where: { role: Role.SUPER_ADMIN },
    });
    const me = (req as any).admin?.sub as string | undefined;
    // Never delete the last super-admin or yourself.
    if (count > 1 && id !== me) {
      const u = await this.prisma.user.findUnique({
        where: { id },
        select: { email: true, role: true },
      });
      if (u?.role === Role.SUPER_ADMIN) {
        await this.prisma.user.delete({ where: { id } }).catch(() => null);
        await this.log(req, 'Remove super-admin', u.email ?? id);
      }
    }
    res.redirect('/admin/admins');
  }

  // ---- Complaints (platform-wide) ----

  @Get('complaints')
  async complaints(@Query('status') status: string, @Res() res: Response) {
    const where =
      status === 'OPEN' || status === 'IN_PROGRESS' || status === 'RESOLVED'
        ? { status: status as any }
        : {};
    const rows = await this.prisma.complaint.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        society: { select: { name: true } },
        flat: { select: { number: true } },
      },
    });
    res.render('admin/complaints', {
      page: 'complaints',
      status: status ?? '',
      complaints: rows.map((c) => ({
        title: c.title,
        category: c.category,
        status: c.status,
        society: c.society?.name ?? '—',
        flat: c.flat?.number ?? '—',
        created: c.createdAt.toDateString(),
      })),
    });
  }

  // ---- Broadcast ----

  @Get('broadcast')
  async broadcastPage(@Query('sent') sent: string, @Res() res: Response) {
    const societies = await this.prisma.society.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.render('admin/broadcast', { page: 'broadcast', sent: !!sent, societies });
  }

  @Post('broadcast')
  async broadcast(
    @Body()
    body: {
      title?: string;
      message?: string;
      target?: string;
      societyIds?: string | string[];
    },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const title = (body.title ?? '').trim();
    const message = (body.message ?? '').trim();
    if (!title || !message) return res.redirect('/admin/broadcast');

    let societyIds: string[];
    if (body.target === 'selected') {
      const raw = body.societyIds;
      const picked = Array.isArray(raw) ? raw : raw ? [raw] : [];
      // Keep only ids that really belong to this platform.
      const valid = await this.prisma.society.findMany({
        where: { id: { in: picked } },
        select: { id: true },
      });
      societyIds = valid.map((s) => s.id);
    } else {
      const all = await this.prisma.society.findMany({ select: { id: true } });
      societyIds = all.map((s) => s.id);
    }

    if (societyIds.length) {
      await this.prisma.notice.createMany({
        data: societyIds.map((id) => ({ societyId: id, title, body: message })),
      });
    }
    await this.log(
      req,
      'Announcement',
      `${title} → ${societyIds.length} societ${societyIds.length === 1 ? 'y' : 'ies'}`,
    );
    res.redirect('/admin/broadcast?sent=1');
  }

  // ---- Notification Center ----

  @Get('notifications')
  async notifications(@Query('sent') sent: string, @Res() res: Response) {
    const [societies, history] = await Promise.all([
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.platformNotification.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);
    res.render('admin/notifications', {
      page: 'notifications',
      sent: !!sent,
      societies,
      history: history.map((n) => ({
        title: n.title,
        channels: n.channels.split(',').join(', '),
        audience: n.audience.replace('_', ' '),
        recipients: n.recipients,
        at: n.createdAt.toLocaleString(),
      })),
    });
  }

  @Post('notifications')
  async sendNotification(
    @Body()
    body: {
      title?: string;
      message?: string;
      channels?: string | string[];
      audience?: string;
      societyIds?: string | string[];
    },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const title = (body.title ?? '').trim();
    const message = (body.message ?? '').trim();
    const channels = (
      Array.isArray(body.channels)
        ? body.channels
        : body.channels
          ? [body.channels]
          : []
    ).filter((c) => ['push', 'email', 'inapp'].includes(c));
    const audience = body.audience ?? 'all_users';
    if (!title || !message || channels.length === 0) {
      return res.redirect('/admin/notifications');
    }

    let societyIds: string[];
    if (audience === 'selected') {
      const raw = body.societyIds;
      const picked = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const valid = await this.prisma.society.findMany({
        where: { id: { in: picked } },
        select: { id: true },
      });
      societyIds = valid.map((s) => s.id);
    } else {
      const all = await this.prisma.society.findMany({ select: { id: true } });
      societyIds = all.map((s) => s.id);
    }

    // In-app is delivered for real via AppNotification; push/email are recorded.
    if (channels.includes('inapp') && societyIds.length) {
      await this.prisma.appNotification.createMany({
        data: societyIds.map((id) => ({
          societyId: id,
          title,
          body: message,
        })),
      });
    }

    await this.prisma.platformNotification.create({
      data: {
        title,
        message,
        channels: channels.join(','),
        audience,
        recipients: societyIds.length,
      },
    });
    await this.log(
      req,
      'Send notification',
      `${title} · ${channels.join('/')} · ${societyIds.length}`,
    );
    res.redirect('/admin/notifications?sent=1');
  }

  // ---- CMS (content pages) ----

  @Get('content')
  async content(@Res() res: Response) {
    const pages = await this.prisma.contentPage.findMany({
      orderBy: { key: 'asc' },
    });
    res.render('admin/content', {
      page: 'content',
      pages: pages.map((p) => ({
        key: p.key,
        title: p.title,
        empty: !p.body.trim(),
        updated: p.updatedAt.toLocaleString(),
      })),
    });
  }

  @Get('content/:key')
  async editContent(
    @Param('key') key: string,
    @Query('ok') ok: string,
    @Res() res: Response,
  ) {
    const p = await this.prisma.contentPage.findUnique({ where: { key } });
    if (!p) return res.redirect('/admin/content');
    res.render('admin/content-edit', {
      page: 'content',
      ok: !!ok,
      p: { key: p.key, title: p.title, body: p.body },
    });
  }

  @Post('content/:key')
  async saveContent(
    @Param('key') key: string,
    @Body() body: { title?: string; body?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const exists = await this.prisma.contentPage.findUnique({ where: { key } });
    if (!exists) return res.redirect('/admin/content');
    await this.prisma.contentPage.update({
      where: { key },
      data: {
        title: (body.title ?? '').trim() || exists.title,
        body: body.body ?? '',
      },
    });
    await this.log(req, 'Edit content', exists.title);
    res.redirect('/admin/content/' + key + '?ok=1');
  }

  // ---- App version ----

  @Get('app-version')
  async appVersion(@Query('ok') ok: string, @Res() res: Response) {
    const cfg = await this.prisma.appConfig.upsert({
      where: { id: 'app' },
      update: {},
      create: { id: 'app' },
    });
    res.render('admin/app-version', {
      page: 'appversion',
      ok: !!ok,
      cfg: {
        androidVersion: cfg.androidVersion,
        iosVersion: cfg.iosVersion,
        forceUpdate: cfg.forceUpdate,
        releaseNotes: cfg.releaseNotes,
        updated: cfg.updatedAt.toLocaleString(),
      },
    });
  }

  @Post('app-version')
  async saveAppVersion(
    @Body()
    body: {
      androidVersion?: string;
      iosVersion?: string;
      updateType?: string;
      releaseNotes?: string;
    },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const androidVersion = (body.androidVersion ?? '').trim() || '1.0.0';
    const iosVersion = (body.iosVersion ?? '').trim() || '1.0.0';
    const forceUpdate = body.updateType === 'force';
    const releaseNotes = (body.releaseNotes ?? '').trim();
    await this.prisma.appConfig.upsert({
      where: { id: 'app' },
      update: { androidVersion, iosVersion, forceUpdate, releaseNotes },
      create: {
        id: 'app',
        androidVersion,
        iosVersion,
        forceUpdate,
        releaseNotes,
      },
    });
    await this.log(
      req,
      'App version',
      `Android ${androidVersion} / iOS ${iosVersion} · ${forceUpdate ? 'Force' : 'Optional'}`,
    );
    res.redirect('/admin/app-version?ok=1');
  }

  // ---- Support tickets ----

  @Get('tickets')
  async tickets(@Query('status') status: string, @Res() res: Response) {
    const valid = ['OPEN', 'PENDING', 'CLOSED'].includes(status);
    const rows = await this.prisma.supportTicket.findMany({
      where: valid ? { status: status as any } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { society: { select: { name: true } } },
    });
    const admins = await this.prisma.user.findMany({
      where: { role: Role.SUPER_ADMIN },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    res.render('admin/tickets', {
      page: 'tickets',
      status: status ?? '',
      assignees: admins.map((a) => a.name),
      tickets: rows.map((t) => ({
        id: t.id,
        subject: t.subject,
        message: t.message,
        category: t.category,
        status: t.status,
        assignee: t.assignee ?? '',
        society: t.society?.name ?? '—',
        created: t.createdAt.toDateString(),
        isOpen: t.status === 'OPEN',
        isPending: t.status === 'PENDING',
        isClosed: t.status === 'CLOSED',
      })),
    });
  }

  @Post('tickets/:id/status')
  async setTicketStatus(
    @Param('id') id: string,
    @Body() body: { status?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const status = body.status ?? '';
    if (['OPEN', 'PENDING', 'CLOSED'].includes(status)) {
      await this.prisma.supportTicket.update({
        where: { id },
        data: { status: status as any },
      });
      await this.log(req, 'Ticket status', status);
    }
    res.redirect('/admin/tickets');
  }

  @Post('tickets/:id/assign')
  async assignTicket(
    @Param('id') id: string,
    @Body() body: { assignee?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const assignee = (body.assignee ?? '').trim() || null;
    await this.prisma.supportTicket.update({
      where: { id },
      data: { assignee },
    });
    await this.log(req, 'Assign ticket', assignee ?? 'Unassigned');
    res.redirect('/admin/tickets');
  }

  // ---- Subscriptions ----

  @Get('subscriptions')
  async subscriptions(@Res() res: Response) {
    const rows = await this.prisma.society.findMany({ orderBy: { name: 'asc' } });
    res.render('admin/subscriptions', {
      page: 'subscriptions',
      societies: rows.map((s) => ({
        id: s.id,
        name: s.name,
        planLabel: PLAN_LABELS[s.plan],
        expires: s.planExpiresAt ? s.planExpiresAt.toDateString() : '—',
        isFree: s.plan === 'FREE',
        isMonthly: s.plan === 'PREMIUM_MONTHLY',
        isYearly: s.plan === 'PREMIUM_YEARLY',
      })),
    });
  }

  @Post('subscriptions/:id')
  async setPlan(
    @Param('id') id: string,
    @Body() body: { plan?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const plan = body.plan as SubscriptionPlan;
    if (!Object.values(SubscriptionPlan).includes(plan)) {
      return res.redirect('/admin/subscriptions');
    }
    let planExpiresAt: Date | null = null;
    if (plan === SubscriptionPlan.PREMIUM_MONTHLY) {
      planExpiresAt = new Date(Date.now() + 30 * DAY);
    } else if (plan === SubscriptionPlan.PREMIUM_YEARLY) {
      planExpiresAt = new Date(Date.now() + 365 * DAY);
    }
    const s = await this.prisma.society.update({
      where: { id },
      data: { plan, planExpiresAt },
      select: { name: true },
    });
    await this.log(req, 'Set plan', `${s.name} → ${PLAN_LABELS[plan]}`);
    res.redirect('/admin/subscriptions');
  }

  // ---- Reports & Analytics ----

  @Get('reports')
  async reports(@Res() res: Response) {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - DAY);
    const monthAgo = new Date(now.getTime() - 30 * DAY);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      dauRows,
      mauRows,
      societies,
      visitorsTotal,
      visitorsInside,
      visitorsToday,
      complaintByStatus,
      complaintByCategory,
      revenueAgg,
      pendingAgg,
      monthAgg,
      billByKind,
    ] = await Promise.all([
      this.prisma.loginEvent.findMany({
        where: { createdAt: { gte: dayAgo }, userId: { not: null } },
        select: { userId: true },
      }),
      this.prisma.loginEvent.findMany({
        where: { createdAt: { gte: monthAgo }, userId: { not: null } },
        select: { userId: true },
      }),
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        include: {
          _count: {
            select: {
              residents: true,
              bills: true,
              complaints: true,
              visitors: true,
            },
          },
        },
      }),
      this.prisma.visitor.count(),
      this.prisma.visitor.count({ where: { status: 'INSIDE' } }),
      this.prisma.visitor.count({ where: { inAt: { gte: monthStart } } }),
      this.prisma.complaint.groupBy({ by: ['status'], _count: true }),
      this.prisma.complaint.groupBy({ by: ['category'], _count: true }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null },
      }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: false, deletedAt: null },
      }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null, paidAt: { gte: monthStart } },
      }),
      this.prisma.bill.groupBy({
        by: ['kind'],
        _sum: { amount: true },
        where: { paid: true, deletedAt: null },
      }),
    ]);

    const dau = new Set(dauRows.map((r) => r.userId)).size;
    const mau = new Set(mauRows.map((r) => r.userId)).size;

    const complaintStatus: Record<string, number> = {};
    for (const g of complaintByStatus) {
      complaintStatus[g.status] = g._count as number;
    }
    const byKind: Record<string, number> = {};
    for (const g of billByKind) byKind[g.kind] = Number(g._sum.amount ?? 0);

    res.render('admin/reports', {
      page: 'reports',
      dau,
      mau,
      visitors: {
        total: visitorsTotal,
        inside: visitorsInside,
        month: visitorsToday,
      },
      complaints: {
        open: complaintStatus['OPEN'] ?? 0,
        inProgress: complaintStatus['IN_PROGRESS'] ?? 0,
        resolved: complaintStatus['RESOLVED'] ?? 0,
        byCategory: complaintByCategory.map((g) => ({
          category: g.category,
          count: g._count as number,
        })),
      },
      payments: {
        revenue: Math.round(Number(revenueAgg._sum.amount ?? 0)),
        pending: Math.round(Number(pendingAgg._sum.amount ?? 0)),
        thisMonth: Math.round(Number(monthAgg._sum.amount ?? 0)),
        rent: Math.round(byKind['RENT'] ?? 0),
        maintenance: Math.round(byKind['MANUAL'] ?? 0),
        other: Math.round(byKind['OTHER'] ?? 0),
      },
      usage: societies.map((s) => ({
        name: s.name,
        residents: s._count.residents,
        bills: s._count.bills,
        complaints: s._count.complaints,
        visitors: s._count.visitors,
      })),
    });
  }

  // ---- Payments ----

  @Get('payments')
  async payments(@Res() res: Response) {
    const [collected, pending, rows] = await Promise.all([
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null },
      }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: false, deletedAt: null },
      }),
      this.prisma.bill.findMany({
        where: { paid: true, deletedAt: null },
        orderBy: { paidAt: 'desc' },
        take: 100,
        include: {
          flat: { select: { number: true } },
          society: { select: { name: true } },
        },
      }),
    ]);
    res.render('admin/payments', {
      page: 'payments',
      collected: Math.round(Number(collected._sum.amount ?? 0)),
      pending: Math.round(Number(pending._sum.amount ?? 0)),
      count: rows.length,
      payments: rows.map((b) => ({
        id: b.id,
        society: b.society?.name ?? '—',
        flat: b.flat?.number ?? '—',
        kind: b.kind,
        amount: Number(b.amount).toFixed(0),
        paidAt: b.paidAt ? b.paidAt.toDateString() : '—',
      })),
    });
  }

  @Post('payments/:id/refund')
  async refund(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const bill = await this.prisma.bill.findUnique({
      where: { id },
      include: { society: { select: { name: true } } },
    });
    if (bill?.paid) {
      await this.prisma.bill.update({
        where: { id },
        data: { paid: false, paidAt: null },
      });
      await this.log(
        req,
        'Payment refunded',
        `${bill.society?.name ?? ''} · ₹${Number(bill.amount).toFixed(0)}`,
      );
    }
    res.redirect('/admin/payments');
  }

  // ---- Feature flags ----

  @Get('flags')
  async flags(@Res() res: Response) {
    const rows = await this.prisma.featureFlag.findMany({
      orderBy: { label: 'asc' },
    });
    res.render('admin/flags', { page: 'flags', flags: rows });
  }

  @Post('flags/:key')
  async toggleFlag(
    @Param('key') key: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const f = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (f) {
      await this.prisma.featureFlag.update({
        where: { key },
        data: { enabled: !f.enabled },
      });
      await this.log(
        req,
        'Feature flag',
        `${f.label}: ${!f.enabled ? 'on' : 'off'}`,
      );
    }
    res.redirect('/admin/flags');
  }

  // ---- Audit log ----

  @Get('audit')
  async audit(@Res() res: Response) {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.render('admin/audit', {
      page: 'audit',
      logs: rows.map((l) => ({
        action: l.action,
        detail: l.detail,
        actor: l.actor,
        at: l.createdAt.toLocaleString(),
      })),
    });
  }

  // ---- Settings ----

  @Get('settings')
  async settings(
    @Query('ok') ok: string,
    @Query('saved') saved: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const s = await this.prisma.platformSettings.upsert({
      where: { id: 'main' },
      update: {},
      create: { id: 'main' },
    });
    res.render('admin/settings', {
      page: 'settings',
      ok: !!ok,
      saved: !!saved,
      error: !!error,
      s: {
        appName: s.appName,
        logoUrl: s.logoUrl ?? '',
        defaultLanguage: s.defaultLanguage,
        maintenanceMode: s.maintenanceMode,
        smtpHost: s.smtpHost ?? '',
        smtpUser: s.smtpUser ?? '',
        smtpPass: s.smtpPass ?? '',
        firebaseKey: s.firebaseKey ?? '',
        paymentKey: s.paymentKey ?? '',
        whatsappKey: s.whatsappKey ?? '',
        smsKey: s.smsKey ?? '',
      },
    });
  }

  @Post('settings/general')
  async saveSettings(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const t = (v?: string) => (v ?? '').trim() || null;
    await this.prisma.platformSettings.update({
      where: { id: 'main' },
      data: {
        appName: (body.appName ?? '').trim() || 'Nestora',
        logoUrl: t(body.logoUrl),
        defaultLanguage: (body.defaultLanguage ?? '').trim() || 'en',
        maintenanceMode: body.maintenanceMode === 'on',
        smtpHost: t(body.smtpHost),
        smtpUser: t(body.smtpUser),
        smtpPass: t(body.smtpPass),
        firebaseKey: t(body.firebaseKey),
        paymentKey: t(body.paymentKey),
        whatsappKey: t(body.whatsappKey),
        smsKey: t(body.smsKey),
      },
    });
    await this.log(req, 'Settings changed', 'Platform settings');
    res.redirect('/admin/settings?saved=1');
  }

  @Post('settings/password')
  async changePassword(
    @Body() body: { current?: string; next?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const id = (req as any).admin?.sub as string | undefined;
    const current = body.current ?? '';
    const next = body.next ?? '';
    if (!id || next.length < 4) return res.redirect('/admin/settings?error=1');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user?.password || !(await bcrypt.compare(current, user.password))) {
      return res.redirect('/admin/settings?error=1');
    }
    await this.prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(next, 10) },
    });
    await this.log(req, 'Change password', user.email ?? id);
    res.redirect('/admin/settings?ok=1');
  }

  // ---- CSV export ----

  @Get('export/societies.csv')
  async exportSocieties(@Res() res: Response) {
    const rows = await this.prisma.society.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { flats: true, residents: true } } },
    });
    const header = 'Name,Address,Flats,Residents,Plan,Suspended,Created\n';
    const body = rows
      .map((s) =>
        [
          csv(s.name),
          csv(s.address),
          s._count.flats,
          s._count.residents,
          s.plan,
          s.suspended,
          s.createdAt.toISOString().slice(0, 10),
        ].join(','),
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=societies.csv');
    res.send(header + body);
  }

  @Get('export/users.csv')
  async exportUsers(@Res() res: Response) {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { society: { select: { name: true } } },
    });
    const header = 'Name,Phone,Email,Role,Society,Banned\n';
    const body = rows
      .map((u) =>
        [
          csv(u.name),
          u.phone,
          csv(u.email ?? ''),
          u.role,
          csv(u.society?.name ?? ''),
          u.banned,
        ].join(','),
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
    res.send(header + body);
  }
}

function csv(v: string): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
