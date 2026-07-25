"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const client_1 = require("@prisma/client");
const bcrypt = __importStar(require("bcrypt"));
const jwt = __importStar(require("jsonwebtoken"));
const prisma_service_1 = require("../prisma.service");
const DAY = 24 * 60 * 60 * 1000;
const PLAN_LABELS = {
    FREE: 'Free',
    PREMIUM_MONTHLY: 'Premium · Monthly',
    PREMIUM_YEARLY: 'Premium · Yearly',
};
const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
let AdminController = class AdminController {
    prisma;
    jwtService;
    config;
    constructor(prisma, jwtService, config) {
        this.prisma = prisma;
        this.jwtService = jwtService;
        this.config = config;
    }
    apiBase() {
        return this.config.get('API_BASE') ?? 'http://localhost:3000';
    }
    logoUrl(path) {
        return path ? this.apiBase() + path : null;
    }
    actor(req) {
        return req.admin?.name ?? 'Super Admin';
    }
    log(req, action, detail) {
        return this.prisma.auditLog
            .create({ data: { action, detail, actor: this.actor(req) } })
            .catch(() => null);
    }
    loginPage(error, res) {
        res.render('admin/login', { error: !!error });
    }
    async login(body, res) {
        const email = (body.email ?? '').trim().toLowerCase();
        const password = body.password ?? '';
        const user = await this.prisma.user.findUnique({ where: { email } });
        const ok = user &&
            user.role === client_1.Role.SUPER_ADMIN &&
            user.password &&
            (await bcrypt.compare(password, user.password));
        if (!ok)
            return res.redirect('/admin/login?error=1');
        const token = this.jwtService.sign({
            sub: user.id,
            name: user.name,
            role: user.role,
        });
        res.cookie('admin_session', token, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 7 * DAY,
        });
        res.redirect('/admin');
    }
    logout(res) {
        res.clearCookie('admin_session');
        res.redirect('/admin/login');
    }
    async dashboard(res) {
        const now = new Date();
        const monthAgo = new Date(now.getTime() - 30 * DAY);
        const twoWeeks = new Date(now.getTime() - 13 * DAY);
        const [totalSocieties, activeSocieties, inactiveSocieties, totalResidents, totalAdmins, totalGuards, totalMaint, totalVisitors, totalComplaints, newRegistrations, revenueAgg, maintenanceAgg, allSoc, paidBills, logins, recent,] = await Promise.all([
            this.prisma.society.count(),
            this.prisma.society.count({ where: { suspended: false } }),
            this.prisma.society.count({ where: { suspended: true } }),
            this.prisma.resident.count({ where: { archivedAt: null } }),
            this.prisma.user.count({ where: { role: client_1.Role.SOCIETY_ADMIN } }),
            this.prisma.user.count({ where: { role: client_1.Role.SECURITY_GUARD } }),
            this.prisma.user.count({ where: { role: client_1.Role.MAINTENANCE_STAFF } }),
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
        const totalMaintenance = Math.round(Number(maintenanceAgg._sum.amount ?? 0));
        const months = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push({
                label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
                societies: 0,
                revenue: 0,
            });
        }
        const monthKey = (d) => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
        for (const s of allSoc) {
            const m = months.find((x) => x.label === monthKey(s.createdAt));
            if (m)
                m.societies++;
        }
        for (const b of paidBills) {
            if (!b.paidAt)
                continue;
            const m = months.find((x) => x.label === monthKey(b.paidAt));
            if (m)
                m.revenue += Number(b.amount);
        }
        const days = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now.getTime() - i * DAY);
            days.push({ label: `${d.getDate()}/${d.getMonth() + 1}`, count: 0 });
        }
        for (const l of logins) {
            const d = l.createdAt;
            const label = `${d.getDate()}/${d.getMonth() + 1}`;
            const day = days.find((x) => x.label === label);
            if (day)
                day.count++;
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
    async societies(res) {
        const rows = await this.prisma.society.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                users: {
                    where: { role: client_1.Role.SOCIETY_ADMIN },
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
    async impersonate(id, req, res) {
        const admin = await this.prisma.user.findFirst({
            where: { societyId: id, role: client_1.Role.SOCIETY_ADMIN },
        });
        const society = await this.prisma.society.findUnique({
            where: { id },
            select: { name: true },
        });
        if (!admin || !society)
            return res.redirect('/admin/societies');
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
        const secret = this.config.get('API_JWT_SECRET') ?? 'dev-secret';
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
    async society(id, res) {
        const s = await this.prisma.society.findUnique({
            where: { id },
            include: {
                _count: { select: { flats: true } },
                users: {
                    where: { role: client_1.Role.SOCIETY_ADMIN },
                    select: { name: true, phone: true },
                },
            },
        });
        if (!s)
            return res.redirect('/admin/societies');
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
    async editSociety(id, body, req, res) {
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
    async toggleSuspend(id, req, res) {
        const s = await this.prisma.society.findUnique({
            where: { id },
            select: { suspended: true, name: true },
        });
        if (s) {
            await this.prisma.society.update({
                where: { id },
                data: { suspended: !s.suspended },
            });
            await this.log(req, s.suspended ? 'Un-suspend society' : 'Suspend society', s.name);
        }
        res.redirect('/admin/societies/' + id);
    }
    async deleteSociety(id, req, res) {
        const s = await this.prisma.society.findUnique({
            where: { id },
            select: { name: true },
        });
        await this.prisma.society.delete({ where: { id } }).catch(() => null);
        if (s)
            await this.log(req, 'Delete society', s.name);
        res.redirect('/admin/societies');
    }
    async users(q, res) {
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
    async toggleBan(id, req, res) {
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
    async admins(res) {
        const rows = await this.prisma.user.findMany({
            where: { role: client_1.Role.SUPER_ADMIN },
            orderBy: { createdAt: 'asc' },
            select: { id: true, name: true, email: true },
        });
        res.render('admin/admins', { page: 'admins', admins: rows });
    }
    async addAdmin(body, req, res) {
        const name = (body.name ?? '').trim();
        const email = (body.email ?? '').trim().toLowerCase();
        const password = body.password ?? '';
        if (name && email && password.length >= 4) {
            const hash = await bcrypt.hash(password, 10);
            const phone = 'sa_' + Date.now();
            await this.prisma.user
                .create({
                data: { name, email, password: hash, phone, role: client_1.Role.SUPER_ADMIN },
            })
                .catch(() => null);
            await this.log(req, 'Add super-admin', email);
        }
        res.redirect('/admin/admins');
    }
    async removeAdmin(id, req, res) {
        const count = await this.prisma.user.count({
            where: { role: client_1.Role.SUPER_ADMIN },
        });
        const me = req.admin?.sub;
        if (count > 1 && id !== me) {
            const u = await this.prisma.user.findUnique({
                where: { id },
                select: { email: true, role: true },
            });
            if (u?.role === client_1.Role.SUPER_ADMIN) {
                await this.prisma.user.delete({ where: { id } }).catch(() => null);
                await this.log(req, 'Remove super-admin', u.email ?? id);
            }
        }
        res.redirect('/admin/admins');
    }
    async complaints(status, res) {
        const where = status === 'OPEN' || status === 'IN_PROGRESS' || status === 'RESOLVED'
            ? { status: status }
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
    async broadcastPage(sent, res) {
        const societies = await this.prisma.society.findMany({
            orderBy: { name: 'asc' },
            select: { id: true, name: true },
        });
        res.render('admin/broadcast', { page: 'broadcast', sent: !!sent, societies });
    }
    async broadcast(body, req, res) {
        const title = (body.title ?? '').trim();
        const message = (body.message ?? '').trim();
        if (!title || !message)
            return res.redirect('/admin/broadcast');
        let societyIds;
        if (body.target === 'selected') {
            const raw = body.societyIds;
            const picked = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const valid = await this.prisma.society.findMany({
                where: { id: { in: picked } },
                select: { id: true },
            });
            societyIds = valid.map((s) => s.id);
        }
        else {
            const all = await this.prisma.society.findMany({ select: { id: true } });
            societyIds = all.map((s) => s.id);
        }
        if (societyIds.length) {
            await this.prisma.notice.createMany({
                data: societyIds.map((id) => ({ societyId: id, title, body: message })),
            });
        }
        await this.log(req, 'Announcement', `${title} → ${societyIds.length} societ${societyIds.length === 1 ? 'y' : 'ies'}`);
        res.redirect('/admin/broadcast?sent=1');
    }
    async notifications(sent, res) {
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
    async sendNotification(body, req, res) {
        const title = (body.title ?? '').trim();
        const message = (body.message ?? '').trim();
        const channels = (Array.isArray(body.channels)
            ? body.channels
            : body.channels
                ? [body.channels]
                : []).filter((c) => ['push', 'email', 'inapp'].includes(c));
        const audience = body.audience ?? 'all_users';
        if (!title || !message || channels.length === 0) {
            return res.redirect('/admin/notifications');
        }
        let societyIds;
        if (audience === 'selected') {
            const raw = body.societyIds;
            const picked = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const valid = await this.prisma.society.findMany({
                where: { id: { in: picked } },
                select: { id: true },
            });
            societyIds = valid.map((s) => s.id);
        }
        else {
            const all = await this.prisma.society.findMany({ select: { id: true } });
            societyIds = all.map((s) => s.id);
        }
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
        await this.log(req, 'Send notification', `${title} · ${channels.join('/')} · ${societyIds.length}`);
        res.redirect('/admin/notifications?sent=1');
    }
    async content(res) {
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
    async editContent(key, ok, res) {
        const p = await this.prisma.contentPage.findUnique({ where: { key } });
        if (!p)
            return res.redirect('/admin/content');
        res.render('admin/content-edit', {
            page: 'content',
            ok: !!ok,
            p: { key: p.key, title: p.title, body: p.body },
        });
    }
    async saveContent(key, body, req, res) {
        const exists = await this.prisma.contentPage.findUnique({ where: { key } });
        if (!exists)
            return res.redirect('/admin/content');
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
    async appVersion(ok, res) {
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
    async saveAppVersion(body, req, res) {
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
        await this.log(req, 'App version', `Android ${androidVersion} / iOS ${iosVersion} · ${forceUpdate ? 'Force' : 'Optional'}`);
        res.redirect('/admin/app-version?ok=1');
    }
    async tickets(status, res) {
        const valid = ['OPEN', 'PENDING', 'CLOSED'].includes(status);
        const rows = await this.prisma.supportTicket.findMany({
            where: valid ? { status: status } : {},
            orderBy: { createdAt: 'desc' },
            take: 200,
            include: { society: { select: { name: true } } },
        });
        const admins = await this.prisma.user.findMany({
            where: { role: client_1.Role.SUPER_ADMIN },
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
    async setTicketStatus(id, body, req, res) {
        const status = body.status ?? '';
        if (['OPEN', 'PENDING', 'CLOSED'].includes(status)) {
            await this.prisma.supportTicket.update({
                where: { id },
                data: { status: status },
            });
            await this.log(req, 'Ticket status', status);
        }
        res.redirect('/admin/tickets');
    }
    async assignTicket(id, body, req, res) {
        const assignee = (body.assignee ?? '').trim() || null;
        await this.prisma.supportTicket.update({
            where: { id },
            data: { assignee },
        });
        await this.log(req, 'Assign ticket', assignee ?? 'Unassigned');
        res.redirect('/admin/tickets');
    }
    async subscriptions(res) {
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
    async setPlan(id, body, req, res) {
        const plan = body.plan;
        if (!Object.values(client_1.SubscriptionPlan).includes(plan)) {
            return res.redirect('/admin/subscriptions');
        }
        let planExpiresAt = null;
        if (plan === client_1.SubscriptionPlan.PREMIUM_MONTHLY) {
            planExpiresAt = new Date(Date.now() + 30 * DAY);
        }
        else if (plan === client_1.SubscriptionPlan.PREMIUM_YEARLY) {
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
    async reports(res) {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - DAY);
        const monthAgo = new Date(now.getTime() - 30 * DAY);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const [dauRows, mauRows, societies, visitorsTotal, visitorsInside, visitorsToday, complaintByStatus, complaintByCategory, revenueAgg, pendingAgg, monthAgg, billByKind,] = await Promise.all([
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
        const complaintStatus = {};
        for (const g of complaintByStatus) {
            complaintStatus[g.status] = g._count;
        }
        const byKind = {};
        for (const g of billByKind)
            byKind[g.kind] = Number(g._sum.amount ?? 0);
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
                    count: g._count,
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
    async payments(res) {
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
    async refund(id, req, res) {
        const bill = await this.prisma.bill.findUnique({
            where: { id },
            include: { society: { select: { name: true } } },
        });
        if (bill?.paid) {
            await this.prisma.bill.update({
                where: { id },
                data: { paid: false, paidAt: null },
            });
            await this.log(req, 'Payment refunded', `${bill.society?.name ?? ''} · ₹${Number(bill.amount).toFixed(0)}`);
        }
        res.redirect('/admin/payments');
    }
    async flags(res) {
        const rows = await this.prisma.featureFlag.findMany({
            orderBy: { label: 'asc' },
        });
        res.render('admin/flags', { page: 'flags', flags: rows });
    }
    async toggleFlag(key, req, res) {
        const f = await this.prisma.featureFlag.findUnique({ where: { key } });
        if (f) {
            await this.prisma.featureFlag.update({
                where: { key },
                data: { enabled: !f.enabled },
            });
            await this.log(req, 'Feature flag', `${f.label}: ${!f.enabled ? 'on' : 'off'}`);
        }
        res.redirect('/admin/flags');
    }
    async audit(res) {
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
    async settings(ok, saved, error, res) {
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
    async saveSettings(body, req, res) {
        const t = (v) => (v ?? '').trim() || null;
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
    async changePassword(body, req, res) {
        const id = req.admin?.sub;
        const current = body.current ?? '';
        const next = body.next ?? '';
        if (!id || next.length < 4)
            return res.redirect('/admin/settings?error=1');
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
    async exportSocieties(res) {
        const rows = await this.prisma.society.findMany({
            orderBy: { createdAt: 'desc' },
            include: { _count: { select: { flats: true, residents: true } } },
        });
        const header = 'Name,Address,Flats,Residents,Plan,Suspended,Created\n';
        const body = rows
            .map((s) => [
            csv(s.name),
            csv(s.address),
            s._count.flats,
            s._count.residents,
            s.plan,
            s.suspended,
            s.createdAt.toISOString().slice(0, 10),
        ].join(','))
            .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=societies.csv');
        res.send(header + body);
    }
    async exportUsers(res) {
        const rows = await this.prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
            include: { society: { select: { name: true } } },
        });
        const header = 'Name,Phone,Email,Role,Society,Banned\n';
        const body = rows
            .map((u) => [
            csv(u.name),
            u.phone,
            csv(u.email ?? ''),
            u.role,
            csv(u.society?.name ?? ''),
            u.banned,
        ].join(','))
            .join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users.csv');
        res.send(header + body);
    }
};
exports.AdminController = AdminController;
__decorate([
    (0, common_1.Get)('login'),
    __param(0, (0, common_1.Query)('error')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], AdminController.prototype, "loginPage", null);
__decorate([
    (0, common_1.Post)('login'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "login", null);
__decorate([
    (0, common_1.Get)('logout'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AdminController.prototype, "logout", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "dashboard", null);
__decorate([
    (0, common_1.Get)('societies'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "societies", null);
__decorate([
    (0, common_1.Post)('societies/:id/impersonate'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "impersonate", null);
__decorate([
    (0, common_1.Get)('societies/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "society", null);
__decorate([
    (0, common_1.Post)('societies/:id/edit'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "editSociety", null);
__decorate([
    (0, common_1.Post)('societies/:id/suspend'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "toggleSuspend", null);
__decorate([
    (0, common_1.Post)('societies/:id/delete'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "deleteSociety", null);
__decorate([
    (0, common_1.Get)('users'),
    __param(0, (0, common_1.Query)('q')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "users", null);
__decorate([
    (0, common_1.Post)('users/:id/ban'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "toggleBan", null);
__decorate([
    (0, common_1.Get)('admins'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "admins", null);
__decorate([
    (0, common_1.Post)('admins'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "addAdmin", null);
__decorate([
    (0, common_1.Post)('admins/:id/delete'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "removeAdmin", null);
__decorate([
    (0, common_1.Get)('complaints'),
    __param(0, (0, common_1.Query)('status')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "complaints", null);
__decorate([
    (0, common_1.Get)('broadcast'),
    __param(0, (0, common_1.Query)('sent')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "broadcastPage", null);
__decorate([
    (0, common_1.Post)('broadcast'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "broadcast", null);
__decorate([
    (0, common_1.Get)('notifications'),
    __param(0, (0, common_1.Query)('sent')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "notifications", null);
__decorate([
    (0, common_1.Post)('notifications'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "sendNotification", null);
__decorate([
    (0, common_1.Get)('content'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "content", null);
__decorate([
    (0, common_1.Get)('content/:key'),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Query)('ok')),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "editContent", null);
__decorate([
    (0, common_1.Post)('content/:key'),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "saveContent", null);
__decorate([
    (0, common_1.Get)('app-version'),
    __param(0, (0, common_1.Query)('ok')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "appVersion", null);
__decorate([
    (0, common_1.Post)('app-version'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "saveAppVersion", null);
__decorate([
    (0, common_1.Get)('tickets'),
    __param(0, (0, common_1.Query)('status')),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "tickets", null);
__decorate([
    (0, common_1.Post)('tickets/:id/status'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "setTicketStatus", null);
__decorate([
    (0, common_1.Post)('tickets/:id/assign'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "assignTicket", null);
__decorate([
    (0, common_1.Get)('subscriptions'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "subscriptions", null);
__decorate([
    (0, common_1.Post)('subscriptions/:id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "setPlan", null);
__decorate([
    (0, common_1.Get)('reports'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "reports", null);
__decorate([
    (0, common_1.Get)('payments'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "payments", null);
__decorate([
    (0, common_1.Post)('payments/:id/refund'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "refund", null);
__decorate([
    (0, common_1.Get)('flags'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "flags", null);
__decorate([
    (0, common_1.Post)('flags/:key'),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "toggleFlag", null);
__decorate([
    (0, common_1.Get)('audit'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "audit", null);
__decorate([
    (0, common_1.Get)('settings'),
    __param(0, (0, common_1.Query)('ok')),
    __param(1, (0, common_1.Query)('saved')),
    __param(2, (0, common_1.Query)('error')),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "settings", null);
__decorate([
    (0, common_1.Post)('settings/general'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "saveSettings", null);
__decorate([
    (0, common_1.Post)('settings/password'),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "changePassword", null);
__decorate([
    (0, common_1.Get)('export/societies.csv'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "exportSocieties", null);
__decorate([
    (0, common_1.Get)('export/users.csv'),
    __param(0, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "exportUsers", null);
exports.AdminController = AdminController = __decorate([
    (0, common_1.Controller)('admin'),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        config_1.ConfigService])
], AdminController);
function csv(v) {
    const s = v ?? '';
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
//# sourceMappingURL=admin.controller.js.map