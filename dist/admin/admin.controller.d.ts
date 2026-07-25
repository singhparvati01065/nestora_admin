import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma.service';
export declare class AdminController {
    private prisma;
    private jwtService;
    private config;
    constructor(prisma: PrismaService, jwtService: JwtService, config: ConfigService);
    private apiBase;
    private logoUrl;
    private actor;
    private log;
    loginPage(error: string, res: Response): void;
    login(body: {
        email?: string;
        password?: string;
    }, res: Response): Promise<void>;
    logout(res: Response): void;
    dashboard(res: Response): Promise<void>;
    societies(res: Response): Promise<void>;
    impersonate(id: string, req: Request, res: Response): Promise<void>;
    society(id: string, res: Response): Promise<void>;
    editSociety(id: string, body: {
        name?: string;
        address?: string;
        city?: string;
        state?: string;
    }, req: Request, res: Response): Promise<void>;
    toggleSuspend(id: string, req: Request, res: Response): Promise<void>;
    deleteSociety(id: string, req: Request, res: Response): Promise<void>;
    users(q: string, res: Response): Promise<void>;
    toggleBan(id: string, req: Request, res: Response): Promise<void>;
    admins(res: Response): Promise<void>;
    addAdmin(body: {
        name?: string;
        email?: string;
        password?: string;
    }, req: Request, res: Response): Promise<void>;
    removeAdmin(id: string, req: Request, res: Response): Promise<void>;
    complaints(status: string, res: Response): Promise<void>;
    broadcastPage(sent: string, res: Response): Promise<void>;
    broadcast(body: {
        title?: string;
        message?: string;
        target?: string;
        societyIds?: string | string[];
    }, req: Request, res: Response): Promise<void>;
    notifications(sent: string, res: Response): Promise<void>;
    sendNotification(body: {
        title?: string;
        message?: string;
        channels?: string | string[];
        audience?: string;
        societyIds?: string | string[];
    }, req: Request, res: Response): Promise<void>;
    content(res: Response): Promise<void>;
    editContent(key: string, ok: string, res: Response): Promise<void>;
    saveContent(key: string, body: {
        title?: string;
        body?: string;
    }, req: Request, res: Response): Promise<void>;
    appVersion(ok: string, res: Response): Promise<void>;
    saveAppVersion(body: {
        androidVersion?: string;
        iosVersion?: string;
        updateType?: string;
        releaseNotes?: string;
    }, req: Request, res: Response): Promise<void>;
    tickets(status: string, res: Response): Promise<void>;
    setTicketStatus(id: string, body: {
        status?: string;
    }, req: Request, res: Response): Promise<void>;
    assignTicket(id: string, body: {
        assignee?: string;
    }, req: Request, res: Response): Promise<void>;
    subscriptions(res: Response): Promise<void>;
    setPlan(id: string, body: {
        plan?: string;
    }, req: Request, res: Response): Promise<void>;
    reports(res: Response): Promise<void>;
    payments(res: Response): Promise<void>;
    refund(id: string, req: Request, res: Response): Promise<void>;
    flags(res: Response): Promise<void>;
    toggleFlag(key: string, req: Request, res: Response): Promise<void>;
    audit(res: Response): Promise<void>;
    settings(ok: string, saved: string, error: string, res: Response): Promise<void>;
    saveSettings(body: Record<string, string>, req: Request, res: Response): Promise<void>;
    changePassword(body: {
        current?: string;
        next?: string;
    }, req: Request, res: Response): Promise<void>;
    exportSocieties(res: Response): Promise<void>;
    exportUsers(res: Response): Promise<void>;
}
