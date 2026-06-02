import { Router } from "express";
import { handleWebchatMessage } from "./webchat.controller.js";

export const webchatRouter: Router = Router();

webchatRouter.post("/message", handleWebchatMessage);