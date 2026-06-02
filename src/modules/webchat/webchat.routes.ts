import { Router } from "express";
import {
    getWebchatConfig,
    handleWebchatMessage,
    handleEndWebchatSession,
    handleGetWebchatMessages,
} from "./webchat.controller.js";

export const webchatRouter: Router = Router();

webchatRouter.get("/config/:businessId", getWebchatConfig);
webchatRouter.get("/messages", handleGetWebchatMessages);
webchatRouter.post("/message", handleWebchatMessage);
webchatRouter.post("/end", handleEndWebchatSession);