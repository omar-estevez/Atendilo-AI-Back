import OpenAI from "openai";
import { env } from "./env.js";

export const groq = env.GROQ_API_KEY
    ? new OpenAI({
        apiKey: env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
    })
    : null;