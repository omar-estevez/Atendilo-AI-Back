import { Router } from "express";
import { webchatRouter } from "./modules/webchat/webchat.routes.js";

export const router: Router = Router();

router.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "atendilo-api",
    });
});

router.use("/webchat", webchatRouter);