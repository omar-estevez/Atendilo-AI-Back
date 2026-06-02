import type { Request, Response } from "express";
import { z } from "zod";
import {
    processWebchatMessage,
    getPublicWebchatConfig,
    endWebchatSession,
    getWebchatMessages,
} from "./webchat.service.js";

const webchatMessageSchema = z.object({
    businessId: z.string().uuid(),
    sessionId: z.string().min(1),
    message: z.string().min(1),
    visitor: z
        .object({
            name: z.string().optional(),
            email: z.string().email().optional(),
            phone: z.string().optional(),
        })
        .optional(),
});

const getWebchatMessagesSchema = z.object({
    businessId: z.string().uuid(),
    sessionId: z.string().min(1),
});

const endWebchatSessionSchema = z.object({
    businessId: z.string().uuid(),
    sessionId: z.string().min(1),
    reason: z.enum(["user", "inactivity"]).optional(),
});

export type WebchatMessageBody = z.infer<typeof webchatMessageSchema>;
export type EndWebchatSessionBody = z.infer<typeof endWebchatSessionSchema>;

export async function handleWebchatMessage(req: Request, res: Response) {
    try {
        const body: WebchatMessageBody = webchatMessageSchema.parse(req.body);

        const result = await processWebchatMessage(body);

        return res.json(result);
    } catch (error) {
        console.error("Webchat message error:", error);

        return res.status(400).json({
            error:
                error instanceof Error
                    ? error.message
                    : "Invalid webchat request",
        });
    }
}

export async function handleEndWebchatSession(req: Request, res: Response) {
    try {
        const body: EndWebchatSessionBody = endWebchatSessionSchema.parse(req.body);

        const result = await endWebchatSession(body);

        return res.json(result);
    } catch (error) {
        console.error("End webchat session error:", error);

        return res.status(400).json({
            error:
                error instanceof Error
                    ? error.message
                    : "Could not end webchat session",
        });
    }
}

export async function handleGetWebchatMessages(req: Request, res: Response) {
    try {
        const query = getWebchatMessagesSchema.parse(req.query);

        const result = await getWebchatMessages(query);

        return res.json(result);
    } catch (error) {
        console.error("Get webchat messages error:", error);

        return res.status(400).json({
            error:
                error instanceof Error
                    ? error.message
                    : "Could not load webchat messages",
        });
    }
}

export async function getWebchatConfig(req: Request, res: Response) {
    try {
        const businessId = z.string().uuid().parse(req.params.businessId);

        const config = await getPublicWebchatConfig(businessId);

        return res.json(config);
    } catch (error: unknown) {
        console.error("Get webchat config error:", error);

        if (error instanceof z.ZodError) {
            return res.status(400).json({
                error: "Invalid business id",
                details: error.issues,
            });
        }

        const message =
            error instanceof Error
                ? error.message
                : "Could not load webchat config";

        return res.status(400).json({
            error: message,
        });
    }
}