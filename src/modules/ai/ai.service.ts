import { gemini } from "../../config/gemini.js";
import { openai } from "../../config/openai.js";
import { env } from "../../config/env.js";

type MessageHistoryItem = {
    role: "user" | "assistant" | "system";
    content: string;
};

type GenerateAiReplyInput = {
    business: Record<string, any>;
    history: MessageHistoryItem[];
    userMessage: string;
};

export async function generateAiReply(input: GenerateAiReplyInput) {
    if (env.AI_PROVIDER === "mock") {
        return generateMockReply(input);
    }

    if (env.AI_PROVIDER === "gemini") {
        return generateGeminiReply(input);
    }

    return generateOpenAiReply(input);
}

async function generateGeminiReply(input: GenerateAiReplyInput) {
    const { business, history, userMessage } = input;

    const businessName =
        business.name || business.business_name || "this business";

    const prompt = `
You are Lumora AI, an assistant for ${businessName}.

Your job:
- Answer customer questions clearly.
- Be friendly and professional.
- Help capture leads.
- If the user wants to book, ask for name, phone, email, preferred date and service.
- Do not invent prices, services, or policies.
- If you do not know something, ask a follow-up question.

Business data:
${JSON.stringify(business, null, 2)}

Conversation history:
${history
            .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
            .join("\n")}

Current user message:
${userMessage}
`;

    try {
        if (!gemini) {
            throw new Error("Gemini client not configured");
        }

        const model = gemini.getGenerativeModel({
            model: env.GEMINI_MODEL,
        });

        const result = await model.generateContent(prompt);
        const response = result.response.text();

        return response || "Sorry, I could not generate a response right now.";
    } catch (error) {
        console.error("Gemini error:", error);
        return generateMockReply(input);
    }
}

async function generateOpenAiReply(input: GenerateAiReplyInput) {
    const { business, history, userMessage } = input;

    const businessName =
        business.name || business.business_name || "this business";

    const systemPrompt = `
You are Lumora AI, an assistant for ${businessName}.

Your job:
- Answer customer questions clearly.
- Be friendly and professional.
- Help capture leads.
- If the user wants to book, ask for name, phone, email, preferred date and service.
- Do not invent prices, services, or policies.
- If you do not know something, ask a follow-up question.

Business data:
${JSON.stringify(business, null, 2)}
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: [
                { role: "system", content: systemPrompt },
                ...history.map((item) => ({
                    role: item.role,
                    content: item.content,
                })),
                { role: "user", content: userMessage },
            ],
            temperature: 0.4,
        });

        return (
            response.choices[0]?.message?.content ??
            "Sorry, I could not generate a response right now."
        );
    } catch (error) {
        console.error("OpenAI error:", error);
        return generateMockReply(input);
    }
}

function generateMockReply(input: GenerateAiReplyInput) {
    return `Thanks for your message. This is a temporary Lumora demo response.

You asked: "${input.userMessage}"

The AI assistant is connected in demo mode.`;
}