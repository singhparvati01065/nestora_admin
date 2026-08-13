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
import { BillKind, Prisma, Role, SubscriptionPlan } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma.service';
import { LoginThrottle } from './login-throttle';

const DAY = 24 * 60 * 60 * 1000;

const PLAN_LABELS: Record<string, string> = {
  FREE: 'Free',
  PREMIUM_MONTHLY: 'Premium · Monthly',
  PREMIUM_YEARLY: 'Premium · Yearly',
};

const BILL_KIND_LABELS: Record<string, string> = {
  RENT: 'Rent',
  MANUAL: 'Maintenance',
  OTHER: 'Other',
};

/// Outline icons for the CMS cards, as SVG path data. Kept here so the view
/// stays free of a switch over page keys.
const CONTENT_ICONS: Record<string, string> = {
  faq: 'M4 5h16v10H9l-5 4z',
  terms: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  privacy: 'M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6z',
  about: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.6v.4',
  contact: 'M3 6h18v12H3zM3 7l9 6 9-6',
};

/// Shortest password the panel accepts. Four was too weak for an account that
/// can suspend a society or delete one.
const MIN_PASSWORD = 8;

/// Rows per page on the list screens. Small on purpose: a page that scrolls
/// past a screenful is harder to scan than one you page through.
const PAGE_SIZE = 10;

/// Sent announcements are full cards, not table rows, so fewer fit a page.
const SENDS_PER_PAGE = 10;

/// Title used for every dues reminder. Fixed, because the panel reads it back
/// to work out when a society was last reminded.
const REMINDER_TITLE = 'Payment reminder';

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
    private throttle: LoginThrottle,
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

  /// Where a form action should return to. Only in-panel paths are honoured,
  /// so a crafted `back` cannot bounce the admin off to another site.
  private safeBack(raw: string | undefined, fallback: string): string {
    return raw && /^\/admin(\/|\?|$)/.test(raw) ? raw : fallback;
  }

  /// Reads a `?page=` value, 1-based, ignoring anything that isn't a number.
  private pageOf(raw?: string): number {
    const n = parseInt(raw ?? '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  /// Everything a list view needs to page through [total] rows, including the
  /// `skip` for the query itself. Filters are passed as [params] so paging
  /// keeps the current search / status instead of dropping it.
  private paginate(
    total: number,
    requested: number,
    path: string,
    params: Record<string, string | undefined> = {},
    /// Rows per page. Table screens keep the default; screens made of big
    /// cards pass something smaller.
    size: number = PAGE_SIZE,
  ) {
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(1, requested), pages);
    const url = (p: number) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
      if (p > 1) qs.set('page', String(p));
      const s = qs.toString();
      return s ? `${path}?${s}` : path;
    };
    return {
      skip: (page - 1) * size,
      pager: {
        /// Only worth drawing once the list actually spans more than one page;
        /// on a short list "Showing 1–3 of 3" is noise.
        show: pages > 1,
        /// This exact view, for actions that should come back to it with the
        /// current filter and page intact.
        selfUrl: url(page),
        page,
        pages,
        total,
        from: total === 0 ? 0 : (page - 1) * size + 1,
        to: Math.min(page * size, total),
        hasPrev: page > 1,
        hasNext: page < pages,
        prevUrl: url(page - 1),
        nextUrl: url(page + 1),
      },
    };
  }

  /// Drops societies whose premium plan has run out back to FREE. The API does
  /// the same lazily when the app reads a society; doing it here too keeps the
  /// panel from showing a plan that has already lapsed.
  private expireLapsedPlans() {
    return this.prisma.society
      .updateMany({
        where: {
          plan: { not: SubscriptionPlan.FREE },
          planExpiresAt: { lt: new Date() },
        },
        data: { plan: SubscriptionPlan.FREE, planExpiresAt: null },
      })
      .catch(() => null);
  }

  /// Asks the API to push to the given societies' admins. The panel holds no
  /// Firebase credentials of its own — the API owns the service account — so
  /// this posts to its internal endpoint with the shared key. Returns how many
  /// devices took it, or null when push is not wired up.
  private async sendPush(
    societyIds: string[],
    title: string,
    body: string,
  ): Promise<number | null> {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key || societyIds.length === 0) return null;
    try {
      const res = await fetch(`${this.apiBase()}/api/internal/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({ societyIds, title, body }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { sent?: number; enabled?: boolean };
      return data.enabled ? (data.sent ?? 0) : null;
    } catch {
      // The API being unreachable must not fail the panel action.
      return null;
    }
  }

  /// "2h ago" style stamp for the dues list, or null when it never happened.
  private ago(at: Date | null): string | null {
    if (!at) return null;
    const mins = Math.floor((Date.now() - at.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days}d ago`;
  }

  private log(req: Request, action: string, detail: string) {
    return this.prisma.auditLog
      .create({ data: { action, detail, actor: this.actor(req) } })
      .catch(() => null);
  }

  // ---- Auth ----

  @Get('login')
  loginPage(
    @Query('error') error: string,
    @Query('locked') locked: string,
    @Res() res: Response,
  ) {
    res.render('admin/login', { error: !!error, locked: locked || null });
  }

  @Post('login')
  async login(
    @Body() body: { email?: string; password?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    // Keyed by caller, not by email: otherwise guessing a different address
    // each time would sail past the limit.
    const key = req.ip ?? 'unknown';

    const wait = this.throttle.lockedFor(key);
    if (wait > 0) {
      return res.redirect(`/admin/login?locked=${Math.ceil(wait / 60)}`);
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok =
      user &&
      user.role === Role.SUPER_ADMIN &&
      user.password &&
      (await bcrypt.compare(password, user.password));
    if (!ok) {
      this.throttle.fail(key);
      return res.redirect('/admin/login?error=1');
    }
    this.throttle.succeed(key);
    const token = this.jwtService.sign({
      sub: user!.id,
      name: user!.name,
      role: user!.role,
    });
    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      // Prod sits behind HTTPS; never let the session ride a plain request.
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * DAY,
    });
    res.redirect('/admin');
  }

  @Post('logout')
  logout(@Res() res: Response) {
    res.clearCookie('admin_session');
    res.redirect('/admin/login');
  }

  // ---- Dashboard ----

  @Get()
  async dashboard(@Res() res: Response) {
    await this.expireLapsedPlans();
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
      outstandingAgg,
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
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: false, deletedAt: null },
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
    const outstanding = Math.round(Number(outstandingAgg._sum.amount ?? 0));

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
        outstanding,
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
  async societies(
    @Query('name') name: string,
    @Query('city') city: string,
    @Query('state') state: string,
    @Query('admin') admin: string,
    @Query('contact') contact: string,
    @Query('plan') plan: string,
    @Query('status') status: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    await this.expireLapsedPlans();

    const nameQuery = (name ?? '').trim();
    const cityQuery = (city ?? '').trim();
    const stateQuery = (state ?? '').trim();
    const adminQuery = (admin ?? '').trim();
    const contactQuery = (contact ?? '').trim();
    const planFilter = Object.values(SubscriptionPlan).includes(
      plan as SubscriptionPlan,
    )
      ? (plan as SubscriptionPlan)
      : undefined;
    const statusFilter =
      status === 'suspended' ? true : status === 'active' ? false : undefined;

    // Collected as AND terms rather than one object: admin and contact both
    // constrain the same `users` relation, and would overwrite each other as
    // sibling keys.
    const terms: Prisma.SocietyWhereInput[] = [];
    const like = (value: string) => ({
      contains: value,
      mode: 'insensitive' as const,
    });
    if (nameQuery) {
      terms.push({
        OR: [{ name: like(nameQuery) }, { address: like(nameQuery) }],
      });
    }
    if (cityQuery) terms.push({ city: like(cityQuery) });
    if (stateQuery) terms.push({ state: like(stateQuery) });
    if (adminQuery) {
      terms.push({
        users: { some: { role: Role.SOCIETY_ADMIN, name: like(adminQuery) } },
      });
    }
    if (contactQuery) {
      terms.push({
        users: {
          some: {
            role: Role.SOCIETY_ADMIN,
            phone: { contains: contactQuery },
          },
        },
      });
    }
    if (planFilter) terms.push({ plan: planFilter });
    if (statusFilter !== undefined) terms.push({ suspended: statusFilter });
    const where: Prisma.SocietyWhereInput = terms.length ? { AND: terms } : {};

    // Distinct cities / states so those columns can offer a list as well as a
    // search box. They come from whatever the app has actually saved, so the
    // list grows on its own as societies are added.
    const [total, allNames, allCities, allStates] = await Promise.all([
      this.prisma.society.count({ where }),
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { name: true },
      }),
      this.prisma.society.findMany({
        where: { city: { not: null } },
        distinct: ['city'],
        orderBy: { city: 'asc' },
        select: { city: true },
      }),
      this.prisma.society.findMany({
        where: { state: { not: null } },
        distinct: ['state'],
        orderBy: { state: 'asc' },
        select: { state: true },
      }),
    ]);
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/societies',
      {
        name: nameQuery,
        city: cityQuery,
        state: stateQuery,
        admin: adminQuery,
        contact: contactQuery,
        plan,
        status,
      },
    );
    const rows = await this.prisma.society.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      include: {
        users: {
          where: { role: Role.SOCIETY_ADMIN, archivedAt: null },
          select: { name: true, phone: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const filterUrl = (over: Record<string, string | undefined>) => {
      const merged: Record<string, string | undefined> = {
        name: nameQuery,
        city: cityQuery,
        state: stateQuery,
        admin: adminQuery,
        contact: contactQuery,
        plan,
        status,
        ...over,
      };
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
      const s = qs.toString();
      return s ? `/admin/societies?${s}` : '/admin/societies';
    };
    const option = (
      label: string,
      key: string,
      value: string | undefined,
      current: string | undefined,
    ) => ({
      label,
      url: filterUrl({ [key]: value }),
      selected: (value ?? '') === (current ?? ''),
    });
    const others = (except: string) =>
      [
        { name: 'name', value: nameQuery },
        { name: 'city', value: cityQuery },
        { name: 'state', value: stateQuery },
        { name: 'admin', value: adminQuery },
        { name: 'contact', value: contactQuery },
        { name: 'plan', value: planFilter ?? '' },
        { name: 'status', value: status ?? '' },
      ].filter((f) => f.name !== except && f.value);
    const search = (
      field: string,
      value: string,
      placeholder: string,
    ) => ({
      action: '/admin/societies',
      field,
      value,
      placeholder,
      hidden: others(field),
      clearUrl: filterUrl({ [field]: undefined }),
    });

    res.render('admin/societies', {
      page: 'societies',
      total,
      filtered: !!(
        nameQuery ||
        cityQuery ||
        stateQuery ||
        adminQuery ||
        contactQuery ||
        planFilter ||
        status
      ),
      filters: {
        // Search box plus the full list of names, so you can either type or
        // just pick. Clicking a name searches for exactly that name.
        name: {
          ...search('name', nameQuery, 'Search society…'),
          active: !!nameQuery,
          options: [
            option('All societies', 'name', undefined, nameQuery),
            ...allNames.map((s) =>
              option(s.name, 'name', s.name, nameQuery),
            ),
          ],
        },
        city: {
          ...search('city', cityQuery, 'Search city…'),
          active: !!cityQuery,
          options: [
            option('All cities', 'city', undefined, cityQuery),
            ...allCities.map((c) =>
              option(c.city as string, 'city', c.city as string, cityQuery),
            ),
          ],
        },
        state: {
          ...search('state', stateQuery, 'Search state…'),
          active: !!stateQuery,
          options: [
            option('All states', 'state', undefined, stateQuery),
            ...allStates.map((c) =>
              option(c.state as string, 'state', c.state as string, stateQuery),
            ),
          ],
        },
        admin: search('admin', adminQuery, 'Search admin…'),
        contact: search('contact', contactQuery, 'Phone number'),
        plan: {
          active: !!planFilter,
          options: [
            option('Any plan', 'plan', undefined, planFilter),
            ...Object.values(SubscriptionPlan).map((p) =>
              option(PLAN_LABELS[p], 'plan', p, planFilter),
            ),
          ],
        },
        status: {
          active: !!status,
          options: [
            option('Any status', 'status', undefined, status),
            option('Active', 'status', 'active', status),
            option('Suspended', 'status', 'suspended', status),
          ],
        },
      },
      pager,
      societies: rows.map((s) => ({
        id: s.id,
        name: s.name,
        logo: this.logoUrl(s.logoUrl),
        initial: s.name.charAt(0).toUpperCase(),
        city: s.city ?? '—',
        state: s.state ?? '—',
        // Societies usually have one admin, but nothing stops a second — and
        // showing only the first hid whoever else could act on the society.
        adminName: s.users.map((u) => u.name).join(', ') || '—',
        contact: s.users.map((u) => u.phone).join(', ') || '—',
        plan: PLAN_LABELS[s.plan],
        isFree: s.plan === 'FREE',
        suspended: s.suspended,
        created: s.createdAt.toDateString(),
      })),
    });
  }

  @Get('societies/:id')
  async society(
    @Param('id') id: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
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

    // The tables below show the latest 50; the tiles must state the real
    // totals, so they are counted separately rather than read off the lists.
    const staffWhere = {
      societyId: id,
      role: { in: [Role.SECURITY_GUARD, Role.MAINTENANCE_STAFF] },
      archivedAt: null,
    };
    const [
      residents,
      bills,
      complaints,
      staff,
      residentCount,
      billCount,
      complaintCount,
      guardCount,
      maintenanceCount,
    ] = await Promise.all([
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
      this.prisma.user.findMany({
        where: staffWhere,
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        select: {
          name: true,
          phone: true,
          role: true,
          trades: true,
          banned: true,
        },
      }),
      this.prisma.resident.count({ where: { societyId: id, archivedAt: null } }),
      this.prisma.bill.count({ where: { societyId: id, deletedAt: null } }),
      this.prisma.complaint.count({ where: { societyId: id } }),
      this.prisma.user.count({
        where: { societyId: id, role: Role.SECURITY_GUARD, archivedAt: null },
      }),
      this.prisma.user.count({
        where: {
          societyId: id,
          role: Role.MAINTENANCE_STAFF,
          archivedAt: null,
        },
      }),
    ]);

    res.render('admin/society', {
      page: 'societies',
      confirmError: error === 'confirm',
      s: {
        id: s.id,
        name: s.name,
        // The picture the society's own admin set in the app.
        logo: this.logoUrl(s.logoUrl),
        initial: s.name.charAt(0).toUpperCase(),
        address: s.address,
        city: s.city ?? '',
        state: s.state ?? '',
        flats: s._count.flats,
        residents: residentCount,
        guards: guardCount,
        maintenance: maintenanceCount,
        staff: guardCount + maintenanceCount,
        bills: billCount,
        complaints: complaintCount,
        plan: PLAN_LABELS[s.plan],
        suspended: s.suspended,
        created: s.createdAt.toDateString(),
        admins: s.users,
      },
      staff: staff.map((u) => ({
        name: u.name,
        phone: u.phone,
        role: u.role === Role.SECURITY_GUARD ? 'Security Guard' : 'Maintenance',
        trades: u.trades.join(', '),
        banned: u.banned,
      })),
      // Only worth saying when the table is actually cut short.
      residentsTruncated: residentCount > residents.length,
      billsTruncated: billCount > bills.length,
      complaintsTruncated: complaintCount > complaints.length,
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

  /// Deletion cascades through every flat, resident, bill and complaint the
  /// society owns, so it is not a one-click action: the operator has to type
  /// the society's name back.
  @Post('societies/:id/delete')
  async deleteSociety(
    @Param('id') id: string,
    @Body() body: { confirm?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const s = await this.prisma.society.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!s) return res.redirect('/admin/societies');

    const typed = (body.confirm ?? '').trim().toLowerCase();
    if (typed !== s.name.trim().toLowerCase()) {
      return res.redirect(`/admin/societies/${id}?error=confirm`);
    }

    await this.prisma.society.delete({ where: { id } }).catch(() => null);
    await this.log(req, 'Delete society', s.name);
    res.redirect('/admin/societies');
  }

  // ---- Users ----

  @Get('users')
  async users(
    @Query('name') name: string,
    @Query('phone') phone: string,
    @Query('role') role: string,
    @Query('societyId') societyId: string,
    @Query('status') status: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    // Name and phone filter their own columns, so they are separate terms.
    const nameQuery = (name ?? '').trim();
    const phoneQuery = (phone ?? '').trim();
    const roleFilter = Object.values(Role).includes(role as Role)
      ? (role as Role)
      : undefined;
    const societyFilter = societyId ? societyId : undefined;
    const statusFilter =
      status === 'blocked' ? true : status === 'active' ? false : undefined;

    const where: Prisma.UserWhereInput = {
      ...(nameQuery
        ? {
            OR: [
              { name: { contains: nameQuery, mode: 'insensitive' as const } },
              { email: { contains: nameQuery, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(phoneQuery ? { phone: { contains: phoneQuery } } : {}),
      ...(roleFilter ? { role: roleFilter } : {}),
      ...(societyFilter !== undefined ? { societyId: societyFilter } : {}),
      ...(statusFilter !== undefined ? { banned: statusFilter } : {}),
    };

    const [total, societies] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
    ]);
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/users',
      { name: nameQuery, phone: phoneQuery, role, societyId, status },
    );

    /// A link to this same list with one filter swapped — the column menus are
    /// built out of these, so picking a role keeps the society filter on.
    /// Paging resets, since page 3 of the old filter means nothing here.
    const filterUrl = (over: Record<string, string | undefined>) => {
      const merged: Record<string, string | undefined> = {
        name: nameQuery,
        phone: phoneQuery,
        role,
        societyId,
        status,
        ...over,
      };
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
      const s = qs.toString();
      return s ? `/admin/users?${s}` : '/admin/users';
    };
    const option = (
      label: string,
      key: string,
      value: string | undefined,
      current: string | undefined,
    ) => ({
      label,
      url: filterUrl({ [key]: value }),
      selected: (value ?? '') === (current ?? ''),
    });
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      include: { society: { select: { name: true } } },
    });
    /// The filters a search box must carry through untouched, so submitting
    /// the Name box does not wipe the Role one.
    const others = (except: string) =>
      [
        { name: 'name', value: nameQuery },
        { name: 'phone', value: phoneQuery },
        { name: 'role', value: roleFilter ?? '' },
        { name: 'societyId', value: societyId ?? '' },
        { name: 'status', value: status ?? '' },
      ].filter((f) => f.name !== except && f.value);

    res.render('admin/users', {
      page: 'users',
      // Any filter on means the "Clear" link is worth offering.
      filtered: !!(
        nameQuery ||
        phoneQuery ||
        roleFilter ||
        societyId ||
        status
      ),
      total,
      /// One menu per filterable column, rendered from the table header.
      filters: {
        name: {
          action: '/admin/users',
          field: 'name',
          value: nameQuery,
          placeholder: 'Search name…',
          hidden: others('name'),
          clearUrl: filterUrl({ name: undefined }),
        },
        phone: {
          action: '/admin/users',
          field: 'phone',
          value: phoneQuery,
          placeholder: 'Phone number',
          hidden: others('phone'),
          clearUrl: filterUrl({ phone: undefined }),
        },
        role: {
          active: !!roleFilter,
          options: [
            option('Any role', 'role', undefined, roleFilter),
            ...Object.values(Role).map((r) =>
              option(r.replace('_', ' '), 'role', r, roleFilter),
            ),
          ],
        },
        society: {
          active: !!societyId,
          // No `field`: the filter travels as an id, so the box only sifts the
          // list below it — clicking a name is what applies the filter.
          placeholder: 'Search society…',
          options: [
            option('Any society', 'societyId', undefined, societyId),
            ...societies.map((s) =>
              option(s.name, 'societyId', s.id, societyId),
            ),
          ],
        },
        status: {
          active: !!status,
          options: [
            option('Any status', 'status', undefined, status),
            option('Active', 'status', 'active', status),
            option('Blocked', 'status', 'blocked', status),
          ],
        },
      },
      pager,
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
    @Body() body: { back?: string },
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
    // Back to the same filtered page, not the top of an unfiltered list.
    res.redirect(this.safeBack(body.back, '/admin/users'));
  }

  // ---- Super admins ----

  @Get('admins')
  async admins(@Query('page') page: string, @Res() res: Response) {
    const where = { role: Role.SUPER_ADMIN };
    const total = await this.prisma.user.count({ where });
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/admins',
    );
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip,
      take: PAGE_SIZE,
      select: { id: true, name: true, email: true },
    });
    res.render('admin/admins', {
      page: 'admins',
      total,
      pager,
      admins: rows,
    });
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
    if (name && email && password.length >= MIN_PASSWORD) {
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
  async complaints(
    @Query('status') status: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    const filtered =
      status === 'OPEN' || status === 'IN_PROGRESS' || status === 'RESOLVED';
    const where = filtered ? { status: status as any } : {};
    const total = await this.prisma.complaint.count({ where });
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/complaints',
      { status: filtered ? status : undefined },
    );
    const rows = await this.prisma.complaint.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      include: {
        society: { select: { name: true } },
        flat: { select: { number: true } },
      },
    });
    res.render('admin/complaints', {
      page: 'complaints',
      status: status ?? '',
      pager,
      complaints: rows.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        status: c.status,
        assignedTo: c.assignedTo ?? '',
        society: c.society?.name ?? '—',
        flat: c.flat?.number ?? '—',
        created: c.createdAt.toDateString(),
        isOpen: c.status === 'OPEN',
        isInProgress: c.status === 'IN_PROGRESS',
        isResolved: c.status === 'RESOLVED',
      })),
    });
  }

  /// Support can move a complaint along — the society's own admin does this in
  /// the app, but a stuck complaint should not need them.
  @Post('complaints/:id/status')
  async setComplaintStatus(
    @Param('id') id: string,
    @Body() body: { status?: string; back?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const status = body.status ?? '';
    if (['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(status)) {
      const c = await this.prisma.complaint
        .update({
          where: { id },
          data: { status: status as any },
          select: { title: true },
        })
        .catch(() => null);
      if (c) await this.log(req, 'Complaint status', `${c.title} → ${status}`);
    }
    res.redirect(this.safeBack(body.back, '/admin/complaints'));
  }

  @Post('complaints/:id/assign')
  async assignComplaint(
    @Param('id') id: string,
    @Body() body: { assignedTo?: string; back?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const assignedTo = (body.assignedTo ?? '').trim() || null;
    const c = await this.prisma.complaint
      .update({
        where: { id },
        data: { assignedTo },
        select: { title: true },
      })
      .catch(() => null);
    if (c) {
      await this.log(
        req,
        'Complaint assigned',
        `${c.title} → ${assignedTo ?? 'Unassigned'}`,
      );
    }
    res.redirect(this.safeBack(body.back, '/admin/complaints'));
  }

  // ---- Broadcast ----

  @Get('broadcast')
  async broadcastPage(
    @Query('sent') sent: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    const [societies, rows] = await Promise.all([
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.notice.findMany({
        where: { fromPlatform: true },
        orderBy: { createdAt: 'desc' },
        // Grouping happens below, so the rows have to be read before they can
        // be paged. The cap is a safety net: 5000 rows is ~1600 sends across
        // three societies, far past anything this page needs to show.
        take: 5000,
        include: { society: { select: { name: true } } },
      }),
    ]);

    // One announcement writes a notice per society, so the rows are regrouped
    // back into the single send they came from — same text, same minute.
    const groups = new Map<
      string,
      { title: string; body: string; at: Date; societies: string[]; ids: string[] }
    >();
    for (const n of rows) {
      const key = `${n.title}|${n.body}|${n.createdAt.toISOString().slice(0, 16)}`;
      const group = groups.get(key);
      if (group) {
        group.societies.push(n.society?.name ?? '—');
        group.ids.push(n.id);
      } else {
        groups.set(key, {
          title: n.title,
          body: n.body,
          at: n.createdAt,
          societies: [n.society?.name ?? '—'],
          ids: [n.id],
        });
      }
    }

    const sends = [...groups.values()];
    const { skip, pager } = this.paginate(
      sends.length,
      this.pageOf(page),
      '/admin/broadcast',
      {},
      SENDS_PER_PAGE,
    );

    res.render('admin/broadcast', {
      page: 'broadcast',
      sent: !!sent,
      societies,
      total: sends.length,
      pager,
      history: sends.slice(skip, skip + SENDS_PER_PAGE).map((g) => ({
        title: g.title,
        body: g.body,
        at: g.at.toLocaleString(),
        count: g.societies.length,
        societies: g.societies.sort().join(', '),
        ids: g.ids.join(','),
      })),
    });
  }

  /// Takes an announcement back: deletes the notice it wrote in every society.
  /// Only platform notices are touched, so a society's own board is safe even
  /// if an id from it were passed.
  @Post('broadcast/delete')
  async unsendBroadcast(
    @Body() body: { ids?: string; title?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const ids = (body.ids ?? '').split(',').filter(Boolean);
    if (ids.length) {
      const removed = await this.prisma.notice.deleteMany({
        where: { id: { in: ids }, fromPlatform: true },
      });
      await this.log(
        req,
        'Announcement removed',
        `${body.title ?? ''} · ${removed.count} societ${removed.count === 1 ? 'y' : 'ies'}`,
      );
    }
    res.redirect('/admin/broadcast');
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
        // Marked as ours, so the app can label it and the society admin cannot
        // quietly pin or delete a platform announcement.
        data: societyIds.map((id) => ({
          societyId: id,
          title,
          body: message,
          fromPlatform: true,
        })),
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
  async notifications(
    @Query('sent') sent: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    const total = await this.prisma.platformNotification.count();
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/notifications',
      {},
      SENDS_PER_PAGE,
    );
    const [societies, history] = await Promise.all([
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.platformNotification.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: SENDS_PER_PAGE,
      }),
    ]);

    const CHANNEL_LABELS: Record<string, string> = {
      inapp: 'In-app',
      push: 'Push',
      email: 'Email',
    };
    const AUDIENCE_LABELS: Record<string, string> = {
      all_users: 'All societies',
      all_admins: 'All society admins',
      selected: 'Selected societies',
    };

    res.render('admin/notifications', {
      page: 'notifications',
      sent: !!sent,
      societies,
      total,
      pager,
      history: history.map((n) => ({
        title: n.title,
        message: n.message,
        channels: n.channels
          .split(',')
          .map((c) => CHANNEL_LABELS[c] ?? c)
          .join(' · '),
        audience: AUDIENCE_LABELS[n.audience] ?? n.audience,
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

    // Push is delivered for real when the API has a service account; email is
    // still only recorded (no provider yet).
    let pushed: number | null = null;
    if (channels.includes('push')) {
      pushed = await this.sendPush(societyIds, title, message);
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
      `${title} · ${channels.join('/')} · ${societyIds.length}` +
        (pushed === null ? '' : ` · ${pushed} device(s) pushed`),
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
      pages: pages.map((p) => {
        const body = p.body.trim();
        return {
          key: p.key,
          title: p.title,
          iconPath: CONTENT_ICONS[p.key] ?? CONTENT_ICONS.about,
          empty: !body,
          // The opening lines, so the list says what is inside a page without
          // opening it.
          preview: body.split('\n').slice(0, 3).join(' ').slice(0, 130),
          words: body ? body.split(/\s+/).length : 0,
          updated: p.updatedAt.toLocaleString(),
        };
      }),
      emptyCount: pages.filter((p) => !p.body.trim()).length,
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
    const words = p.body.trim() ? p.body.trim().split(/\s+/).length : 0;
    res.render('admin/content-edit', {
      page: 'content',
      ok: !!ok,
      // The FAQ is the one page the app folds into questions, so it is the one
      // page whose formatting help differs.
      isFaq: p.key === 'faq',
      p: {
        key: p.key,
        title: p.title,
        body: p.body,
        words,
        empty: !p.body.trim(),
        updated: p.updatedAt.toLocaleString(),
      },
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
    const [cfg, settings] = await Promise.all([
      this.prisma.appConfig.upsert({
        where: { id: 'app' },
        update: {},
        create: { id: 'app' },
      }),
      this.prisma.platformSettings.findUnique({ where: { id: 'main' } }),
    ]);
    res.render('admin/app-version', {
      page: 'appversion',
      ok: !!ok,
      // The app reads this exact endpoint on launch; showing it makes the
      // page's effect concrete rather than something to take on trust.
      apiUrl: `${this.apiBase()}/api/app-version`,
      maintenanceMode: settings?.maintenanceMode ?? false,
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
  async tickets(
    @Query('status') status: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    const valid = ['OPEN', 'PENDING', 'CLOSED'].includes(status);
    const where = valid ? { status: status as any } : {};
    const total = await this.prisma.supportTicket.count({ where });
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/tickets',
      { status: valid ? status : undefined },
    );
    const rows = await this.prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
      include: { society: { select: { name: true } } },
    });
    const admins = await this.prisma.user.findMany({
      where: { role: Role.SUPER_ADMIN },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const replies = await this.prisma.ticketReply.findMany({
      where: { ticketId: { in: rows.map((t) => t.id) } },
      orderBy: { createdAt: 'asc' },
    });
    /// Short, readable stamp: "25 Jul, 1:19 pm".
    const stamp = (d: Date) =>
      `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` +
      `, ${d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      })}`;

    /// The whole conversation as one list, the ticket's own message first —
    /// the same shape the app shows, so both sides read alike.
    const threadOf = (ticket: (typeof rows)[number]) => [
      {
        body: ticket.message,
        author: ticket.society?.name ?? 'Society',
        fromSociety: true,
        at: stamp(ticket.createdAt),
      },
      ...replies
        .filter((r) => r.ticketId === ticket.id)
        .map((r) => ({
          body: r.body,
          author: r.author,
          fromSociety: !r.fromSupport,
          at: stamp(r.createdAt),
        })),
    ];
    res.render('admin/tickets', {
      page: 'tickets',
      status: status ?? '',
      pager,
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
        thread: threadOf(t),
        replyCount: replies.filter((r) => r.ticketId === t.id).length,
      })),
    });
  }

  /// Answers a ticket. The reply shows up on the society admin's Support
  /// screen in the app, and an in-app notification tells them to look.
  @Post('tickets/:id/reply')
  async replyToTicket(
    @Param('id') id: string,
    @Body() body: { body?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const text = (body.body ?? '').trim();
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: { subject: true, societyId: true },
    });
    if (!ticket || !text) return res.redirect('/admin/tickets');

    await this.prisma.ticketReply.create({
      data: { ticketId: id, body: text, author: this.actor(req) },
    });
    await this.prisma.appNotification
      .create({
        data: {
          societyId: ticket.societyId,
          title: 'Support replied',
          body: `Re: ${ticket.subject}`,
        },
      })
      .catch(() => null);
    void this.sendPush(
      [ticket.societyId],
      'Support replied',
      `Re: ${ticket.subject}`,
    );
    await this.log(req, 'Ticket reply', ticket.subject);
    res.redirect('/admin/tickets');
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
  async subscriptions(@Query('page') page: string, @Res() res: Response) {
    await this.expireLapsedPlans();
    const total = await this.prisma.society.count();
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/subscriptions',
    );
    const rows = await this.prisma.society.findMany({
      orderBy: { name: 'asc' },
      skip,
      take: PAGE_SIZE,
    });
    res.render('admin/subscriptions', {
      page: 'subscriptions',
      pager,
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

  /// A date as YYYY-MM-DD in local time. `toISOString()` would shift it to
  /// UTC and show the day before for anywhere east of Greenwich.
  private isoDay(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /// Resolves the window a report covers. Presets keep the common cases one
  /// click away; explicit from/to wins when both are given. Defaults to the
  /// last 30 days — long enough to be useful, short enough to load fast.
  private reportRange(preset?: string, from?: string, to?: string) {
    const now = new Date();
    const startOfDay = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const endOfDay = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

    const parsed = (value?: string) => {
      if (!value) return null;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const fromDate = parsed(from);
    const toDate = parsed(to);
    if (fromDate && toDate) {
      return {
        preset: 'custom',
        from: startOfDay(fromDate),
        to: endOfDay(toDate),
      };
    }

    switch (preset) {
      case '7d':
        return {
          preset: '7d',
          from: startOfDay(new Date(now.getTime() - 6 * DAY)),
          to: endOfDay(now),
        };
      case 'month':
        return {
          preset: 'month',
          from: new Date(now.getFullYear(), now.getMonth(), 1),
          to: endOfDay(now),
        };
      case 'lastmonth': {
        const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const last = new Date(now.getFullYear(), now.getMonth(), 0);
        return { preset: 'lastmonth', from: first, to: endOfDay(last) };
      }
      case 'all':
        return { preset: 'all', from: new Date(2000, 0, 1), to: endOfDay(now) };
      default:
        return {
          preset: '30d',
          from: startOfDay(new Date(now.getTime() - 29 * DAY)),
          to: endOfDay(now),
        };
    }
  }

  /// Everything the reports screen counts, for one window. Shared with the CSV
  /// export so the file and the page can never disagree.
  private async reportData(from: Date, to: Date) {
    const within = { gte: from, lte: to };
    const now = new Date();

    const [
      logins,
      societies,
      visitorsInRange,
      visitorsInside,
      complaintByStatus,
      complaintByCategory,
      collectedAgg,
      pendingAgg,
      billByKind,
      billsPerSociety,
      complaintsPerSociety,
      visitorsPerSociety,
      residentsPerSociety,
    ] = await Promise.all([
      this.prisma.loginEvent.findMany({
        where: { createdAt: within, userId: { not: null } },
        select: { userId: true, createdAt: true },
      }),
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.visitor.count({ where: { inAt: within } }),
      this.prisma.visitor.count({ where: { status: 'INSIDE' } }),
      this.prisma.complaint.groupBy({
        by: ['status'],
        _count: true,
        where: { createdAt: within },
      }),
      this.prisma.complaint.groupBy({
        by: ['category'],
        _count: true,
        where: { createdAt: within },
      }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null, paidAt: within },
      }),
      // Outstanding is a "right now" figure, not something a window bounds.
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: false, deletedAt: null },
      }),
      this.prisma.bill.groupBy({
        by: ['kind'],
        _sum: { amount: true },
        where: { paid: true, deletedAt: null, paidAt: within },
      }),
      this.prisma.bill.groupBy({
        by: ['societyId'],
        _count: true,
        where: { deletedAt: null, createdAt: within },
      }),
      this.prisma.complaint.groupBy({
        by: ['societyId'],
        _count: true,
        where: { createdAt: within },
      }),
      this.prisma.visitor.groupBy({
        by: ['societyId'],
        _count: true,
        where: { inAt: within },
      }),
      // Residents are a standing count, not a flow — the window does not apply.
      this.prisma.resident.groupBy({
        by: ['societyId'],
        _count: true,
        where: { archivedAt: null },
      }),
    ]);

    // Daily login counts across the window, zero-filled so gaps show as gaps.
    const days: { label: string; count: number; users: Set<string> }[] = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const dayKey = (d: Date) =>
      `${d.getDate()}/${d.getMonth() + 1}`;
    while (cursor <= to && days.length < 120) {
      days.push({ label: dayKey(cursor), count: 0, users: new Set() });
      cursor.setDate(cursor.getDate() + 1);
    }
    for (const l of logins) {
      const day = days.find((d) => d.label === dayKey(l.createdAt));
      if (day) {
        day.count++;
        if (l.userId) day.users.add(l.userId);
      }
    }

    const countBy = (
      rows: { societyId: string; _count: number }[],
      id: string,
    ) => rows.find((r) => r.societyId === id)?._count ?? 0;

    const status: Record<string, number> = {};
    for (const g of complaintByStatus) status[g.status] = g._count as number;
    const kind: Record<string, number> = {};
    for (const g of billByKind) kind[g.kind] = Number(g._sum.amount ?? 0);

    return {
      activeUsers: new Set(logins.map((l) => l.userId)).size,
      logins: logins.length,
      dau: new Set(
        logins
          .filter((l) => l.createdAt >= new Date(now.getTime() - DAY))
          .map((l) => l.userId),
      ).size,
      loginSeries: {
        labels: days.map((d) => d.label),
        data: days.map((d) => d.count),
      },
      visitors: { inRange: visitorsInRange, inside: visitorsInside },
      complaints: {
        open: status['OPEN'] ?? 0,
        inProgress: status['IN_PROGRESS'] ?? 0,
        resolved: status['RESOLVED'] ?? 0,
        byCategory: complaintByCategory
          .map((g) => ({ category: g.category, count: g._count as number }))
          .sort((a, b) => b.count - a.count),
      },
      payments: {
        collected: Math.round(Number(collectedAgg._sum.amount ?? 0)),
        pending: Math.round(Number(pendingAgg._sum.amount ?? 0)),
        byKind: Object.values(BillKind).map((k) => ({
          label: BILL_KIND_LABELS[k],
          amount: Math.round(kind[k] ?? 0),
        })),
      },
      usage: societies.map((s) => ({
        name: s.name,
        residents: countBy(residentsPerSociety as never, s.id),
        bills: countBy(billsPerSociety as never, s.id),
        complaints: countBy(complaintsPerSociety as never, s.id),
        visitors: countBy(visitorsPerSociety as never, s.id),
      })),
    };
  }

  @Get('reports')
  async reports(
    @Query('preset') preset: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('page') page: string,
    @Res() res: Response,
  ) {
    const range = this.reportRange(preset, from, to);
    const data = await this.reportData(range.from, range.to);
    const iso = (d: Date) => this.isoDay(d);

    // Only the society table pages; every figure above it is a total for the
    // window and must not change as you page through.
    const { skip, pager } = this.paginate(
      data.usage.length,
      this.pageOf(page),
      '/admin/reports',
      { preset, from, to },
    );

    res.render('admin/reports', {
      page: 'reports',
      ...data,
      usage: data.usage.slice(skip, skip + PAGE_SIZE),
      societyCount: data.usage.length,
      pager,
      range: {
        preset: range.preset,
        from: iso(range.from),
        to: iso(range.to),
        label: `${range.from.toDateString()} — ${range.to.toDateString()}`,
      },
      exportUrl: `/admin/export/reports.csv?from=${iso(range.from)}&to=${iso(range.to)}`,
    });
  }

  // ---- Payments ----

  @Get('payments')
  async payments(
    @Query('societyId') societyId: string,
    @Query('kind') kind: string,
    @Query('status') status: string,
    @Query('page') page: string,
    @Query('reminded') reminded: string,
    @Res() res: Response,
  ) {
    const societyFilter = societyId ? societyId : undefined;
    const kindFilter = Object.values(BillKind).includes(kind as BillKind)
      ? (kind as BillKind)
      : undefined;
    // Unfiltered shows paid AND unpaid: the Pending tile has to be clickable
    // to something, and outstanding bills are the point of the screen.
    const paidFilter =
      status === 'paid' ? true : status === 'unpaid' ? false : undefined;

    const where: Prisma.BillWhereInput = {
      deletedAt: null,
      ...(societyFilter ? { societyId: societyFilter } : {}),
      ...(kindFilter ? { kind: kindFilter } : {}),
      ...(paidFilter !== undefined ? { paid: paidFilter } : {}),
    };

    const [total, collected, pending, societies, unpaidRows, reminders] =
      await Promise.all([
      this.prisma.bill.count({ where }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: true, deletedAt: null },
      }),
      this.prisma.bill.aggregate({
        _sum: { amount: true },
        where: { paid: false, deletedAt: null },
      }),
      this.prisma.society.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      // Everything still owed, so the page can say who owes it rather than
      // only how much the platform is owed in total.
      this.prisma.bill.findMany({
        where: { paid: false, deletedAt: null },
        select: {
          amount: true,
          dueDate: true,
          societyId: true,
          society: { select: { name: true } },
        },
      }),
      // The reminders themselves are the record of when a society was last
      // nudged — no extra column needed.
      this.prisma.appNotification.groupBy({
        by: ['societyId'],
        where: { title: REMINDER_TITLE },
        _max: { createdAt: true },
      }),
    ]);
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/payments',
      { societyId, kind, status },
    );

    const DAY_MS = 24 * 60 * 60 * 1000;
    const dueBySociety = new Map<
      string,
      { name: string; amount: number; count: number; oldest: Date | null }
    >();
    for (const b of unpaidRows) {
      const row = dueBySociety.get(b.societyId) ?? {
        name: b.society?.name ?? '—',
        amount: 0,
        count: 0,
        oldest: null,
      };
      row.amount += Number(b.amount);
      row.count += 1;
      if (b.dueDate && (!row.oldest || b.dueDate < row.oldest)) {
        row.oldest = b.dueDate;
      }
      dueBySociety.set(b.societyId, row);
    }
    const lastReminded = new Map(
      reminders.map((r) => [r.societyId, r._max.createdAt]),
    );
    const dues = [...dueBySociety.entries()]
      .map(([id, d]) => ({
        id,
        name: d.name,
        amount: Math.round(d.amount),
        count: d.count,
        // Days past the oldest unpaid due date; 0 while nothing is late yet.
        overdueDays: d.oldest
          ? Math.max(0, Math.floor((Date.now() - d.oldest.getTime()) / DAY_MS))
          : 0,
        remindedAgo: this.ago(lastReminded.get(id) ?? null),
      }))
      .sort((a, b) => b.amount - a.amount);
    const rows = await this.prisma.bill.findMany({
      where,
      // Nulls sort first on a descending nullable column, so what is still
      // outstanding leads, then paid bills newest-first.
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: PAGE_SIZE,
      include: {
        flat: { select: { number: true } },
        society: { select: { name: true } },
      },
    });

    const filterUrl = (over: Record<string, string | undefined>) => {
      const merged: Record<string, string | undefined> = {
        societyId,
        kind,
        status,
        ...over,
      };
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
      const s = qs.toString();
      return s ? `/admin/payments?${s}` : '/admin/payments';
    };
    const option = (
      label: string,
      key: string,
      value: string | undefined,
      current: string | undefined,
    ) => ({
      label,
      url: filterUrl({ [key]: value }),
      selected: (value ?? '') === (current ?? ''),
    });

    res.render('admin/payments', {
      page: 'payments',
      pager,
      dues,
      duesTotal: dues.reduce((sum, d) => sum + d.amount, 0),
      reminded: reminded ? Number(reminded) : null,
      collected: Math.round(Number(collected._sum.amount ?? 0)),
      pending: Math.round(Number(pending._sum.amount ?? 0)),
      count: total,
      filtered: !!(societyFilter || kindFilter || status),
      unpaidUrl: filterUrl({ status: 'unpaid' }),
      filters: {
        society: {
          active: !!societyFilter,
          placeholder: 'Search society…',
          options: [
            option('Any society', 'societyId', undefined, societyId),
            ...societies.map((s) =>
              option(s.name, 'societyId', s.id, societyId),
            ),
          ],
        },
        kind: {
          active: !!kindFilter,
          options: [
            option('Any type', 'kind', undefined, kindFilter),
            ...Object.values(BillKind).map((k) =>
              option(BILL_KIND_LABELS[k], 'kind', k, kindFilter),
            ),
          ],
        },
        status: {
          active: !!status,
          options: [
            option('Any status', 'status', undefined, status),
            option('Paid', 'status', 'paid', status),
            option('Unpaid', 'status', 'unpaid', status),
          ],
        },
      },
      payments: rows.map((b) => ({
        id: b.id,
        society: b.society?.name ?? '—',
        flat: b.flat?.number ?? '—',
        kind: BILL_KIND_LABELS[b.kind],
        title: b.title,
        amount: Number(b.amount).toFixed(0),
        paid: b.paid,
        due: b.dueDate ? b.dueDate.toDateString() : '—',
        paidAt: b.paidAt ? b.paidAt.toDateString() : '—',
      })),
    });
  }

  /// Nudges one society's admins about what is still unpaid: an in-app
  /// notification (which the bell in the app reads) plus a push when the API
  /// has Firebase wired up. Amount is recomputed here rather than trusted from
  /// the form, so a stale page cannot send a wrong number.
  @Post('payments/remind/:societyId')
  async remindSociety(
    @Param('societyId') societyId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const sent = await this.sendDuesReminder(societyId, req);
    res.redirect(`/admin/payments?reminded=${sent ? 1 : 0}`);
  }

  /// Same nudge, for every society that owes something. Sent one by one on
  /// purpose: the message carries each society's own figures.
  @Post('payments/remind-all')
  async remindAll(@Req() req: Request, @Res() res: Response) {
    const owing = await this.prisma.bill.findMany({
      where: { paid: false, deletedAt: null },
      select: { societyId: true },
      distinct: ['societyId'],
    });
    let sent = 0;
    for (const row of owing) {
      if (await this.sendDuesReminder(row.societyId, req)) sent += 1;
    }
    res.redirect(`/admin/payments?reminded=${sent}`);
  }

  private async sendDuesReminder(societyId: string, req: Request) {
    const [society, unpaid] = await Promise.all([
      this.prisma.society.findUnique({
        where: { id: societyId },
        select: { name: true, suspended: true },
      }),
      this.prisma.bill.findMany({
        where: { societyId, paid: false, deletedAt: null },
        select: { amount: true, dueDate: true },
      }),
    ]);
    // Nothing to chase, or the society is suspended and cannot act on it.
    if (!society || society.suspended || unpaid.length === 0) return false;

    const amount = Math.round(
      unpaid.reduce((sum, b) => sum + Number(b.amount), 0),
    );
    const now = Date.now();
    const overdue = unpaid.filter(
      (b) => b.dueDate && b.dueDate.getTime() < now,
    ).length;
    const body =
      `₹${amount.toLocaleString('en-IN')} is still unpaid across ` +
      `${unpaid.length} bill${unpaid.length === 1 ? '' : 's'}` +
      (overdue ? ` · ${overdue} past the due date` : '') +
      '. Please collect or update the payments.';

    await this.prisma.appNotification.create({
      data: { societyId, title: REMINDER_TITLE, body },
    });
    const pushed = await this.sendPush([societyId], REMINDER_TITLE, body);
    await this.log(
      req,
      'Dues reminder',
      `${society.name} · ₹${amount}` +
        (pushed === null ? '' : ` · ${pushed} device(s) pushed`),
    );
    return true;
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
  async audit(@Query('page') page: string, @Res() res: Response) {
    const total = await this.prisma.auditLog.count();
    const { skip, pager } = this.paginate(
      total,
      this.pageOf(page),
      '/admin/audit',
    );
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: PAGE_SIZE,
    });
    res.render('admin/audit', {
      page: 'audit',
      pager,
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

  /// Maintenance mode gets its own action: it blocks every app in every
  /// society, so it should not ride along with a branding save.
  @Post('settings/maintenance')
  async setMaintenance(
    @Body() body: { on?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const on = body.on === '1';
    await this.prisma.platformSettings.update({
      where: { id: 'main' },
      data: { maintenanceMode: on },
    });
    await this.log(req, 'Maintenance mode', on ? 'ON' : 'OFF');
    res.redirect('/admin/settings?saved=1');
  }

  @Post('settings/general')
  async saveSettings(
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.prisma.platformSettings.update({
      where: { id: 'main' },
      data: {
        appName: (body.appName ?? '').trim() || 'Nestora',
        logoUrl: (body.logoUrl ?? '').trim() || null,
        defaultLanguage: (body.defaultLanguage ?? '').trim() || 'en',
        // The integration key columns are deliberately left alone: no screen
        // writes them any more, and blanking them here would quietly destroy
        // anything already stored.
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
    if (!id || next.length < MIN_PASSWORD) {
      return res.redirect('/admin/settings?error=1');
    }
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
      include: {
        _count: {
          select: {
            flats: true,
            // Removed residents are archived, not deleted — counting them
            // would disagree with every other screen.
            residents: { where: { archivedAt: null } },
          },
        },
      },
    });
    const header =
      'Name,Address,City,State,Flats,Residents,Plan,Suspended,Created\n';
    const body = rows
      .map((s) =>
        [
          csv(s.name),
          csv(s.address),
          csv(s.city ?? ''),
          csv(s.state ?? ''),
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

  /// Every live bill, paid or not — the Payments screen only lists the paid
  /// ones, but reconciling accounts needs what is still outstanding too.
  /// The society-usage table for the same window the screen is showing.
  @Get('export/reports.csv')
  async exportReports(
    @Query('preset') preset: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Res() res: Response,
  ) {
    const range = this.reportRange(preset, from, to);
    const data = await this.reportData(range.from, range.to);
    const iso = (d: Date) => this.isoDay(d);

    const header =
      `Report window,${iso(range.from)} to ${iso(range.to)}\n\n` +
      'Society,Residents,Bills,Complaints,Visitors\n';
    const body = data.usage
      .map((u) =>
        [csv(u.name), u.residents, u.bills, u.complaints, u.visitors].join(','),
      )
      .join('\n');
    const summary =
      `\n\nActive users,${data.activeUsers}\n` +
      `Logins,${data.logins}\n` +
      `Visitors in window,${data.visitors.inRange}\n` +
      `Complaints open,${data.complaints.open}\n` +
      `Complaints in progress,${data.complaints.inProgress}\n` +
      `Complaints resolved,${data.complaints.resolved}\n` +
      `Collected,${data.payments.collected}\n` +
      `Outstanding,${data.payments.pending}\n`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=reports.csv');
    res.send(header + body + summary);
  }

  @Get('export/payments.csv')
  async exportPayments(@Res() res: Response) {
    const rows = await this.prisma.bill.findMany({
      where: { deletedAt: null },
      // Descending on a nullable column puts nulls first, so what is still
      // outstanding lands at the top, then paid bills newest-first.
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        society: { select: { name: true } },
        flat: { select: { number: true } },
      },
    });
    const header =
      'Society,Flat,Period,Kind,Title,Amount,Status,Due,Paid on\n';
    const body = rows
      .map((b) =>
        [
          csv(b.society?.name ?? ''),
          csv(b.flat?.number ?? ''),
          csv(b.period),
          b.kind,
          csv(b.title),
          Number(b.amount).toFixed(2),
          b.paid ? 'PAID' : 'UNPAID',
          b.dueDate ? b.dueDate.toISOString().slice(0, 10) : '',
          b.paidAt ? b.paidAt.toISOString().slice(0, 10) : '',
        ].join(','),
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=payments.csv');
    res.send(header + body);
  }

  @Get('export/audit.csv')
  async exportAudit(@Res() res: Response) {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
    });
    const header = 'When,Action,Detail,By\n';
    const body = rows
      .map((l) =>
        [
          l.createdAt.toISOString(),
          csv(l.action),
          csv(l.detail),
          csv(l.actor),
        ].join(','),
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=audit-log.csv');
    res.send(header + body);
  }
}

function csv(v: string): string {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
