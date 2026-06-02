import { Router } from "express";
import { getWebchatConfig, handleWebchatMessage } from "./webchat.controller.js";

export const webchatRouter: Router = Router();

webchatRouter.get("/config/:businessId", getWebchatConfig);
webchatRouter.post("/message", handleWebchatMessage);