import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "./env.js";

if (env.AI_PROVIDER === "gemini" && !env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required when AI_PROVIDER=gemini");
}

export const gemini = env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(env.GEMINI_API_KEY)
    : null;