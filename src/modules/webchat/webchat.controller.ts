import type { Request, Response } from "express";
import { z } from "zod";
import { processWebchatMessage } from "./webchat.service.js";

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