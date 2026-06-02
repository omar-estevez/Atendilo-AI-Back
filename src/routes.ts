import { Router } from "express";
import { webchatRouter } from "./modules/webchat/webchat.routes.js";

export const router: Router = Router();

router.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "lumora-api",
    });
});

router.use("/webchat", webchatRouter);