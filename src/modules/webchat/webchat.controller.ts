import type { Request, Response } from "express";
import { z } from "zod";
import { processWebchatMessage, getPublicWebchatConfig } from "./webchat.service.js";

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

export type WebchatMessageBody = z.infer<typeof webchatMessageSchema>;

export async function handleWebchatMessage(req: Request, res: Response) {
    try {
        const body: WebchatMessageBody = webchatMessageSchema.parse(req.body);

        const result = await processWebchatMessage(body);

        return res.json(result);
    } catch (error) {
        console.error("Webchat message error:", error);

        return res.status(400).json({
            error: "Invalid webchat request",
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