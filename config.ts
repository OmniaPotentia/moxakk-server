import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

export function setupMiddleware(app: express.Application) {
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https:"],
            },
        },
        referrerPolicy: {
            policy: 'strict-origin-when-cross-origin',
        },
    }));

    app.use(cors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:3000',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    }));

    app.use(express.json());

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 100,
    });
    app.use(limiter);
}
