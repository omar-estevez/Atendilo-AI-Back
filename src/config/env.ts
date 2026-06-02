import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
    PORT: z.coerce.number().default(4000),

    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    OPENAI_API_KEY: z.string().optional(),

    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-flash-latest"),

    GROQ_API_KEY: z.string().optional(),
    GROQ_MODEL: z.string().default("llama-3.1-8b-instant"),

    AI_PROVIDER: z.enum(["mock", "gemini", "openai", "groq"])
        .default("mock"),

    FRONTEND_URL: z.string().url().default("http://localhost:5173"),
});

export const env = envSchema.parse(process.env);