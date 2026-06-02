import { supabase } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { generateAiReply } from "../ai/ai.service.js";
import type { WebchatMessageBody } from "./webchat.controller.js";

type ContactId = string | null;

type ConversationAnalysis = {
    intent: string;
    urgency: string;
    sentiment: string;
    aiScore: number;
    aiSummary: string;
};

export async function processWebchatMessage(input: WebchatMessageBody) {
    const { businessId, sessionId, message, visitor } = input;

    const { data: business, error: businessError } = await supabase
        .from("businesses")
        .select("*")
        .eq("id", businessId)
        .single();

    if (businessError || !business) {
        console.error("Business error:", businessError);
        throw new Error("Business not found");
    }

    const contactId = await findOrCreateContact({
        businessId,
        visitor,
    });

    let conversationId: string;

    const { data: existingSession, error: sessionError } = await supabase
        .from("webchat_sessions")
        .select("conversation_id")
        .eq("business_id", businessId)
        .eq("session_key", sessionId)
        .maybeSingle();

    if (sessionError) {
        console.error("Find webchat session error:", sessionError);
        throw new Error(sessionError.message);
    }

    if (existingSession?.conversation_id) {
        conversationId = existingSession.conversation_id;

        if (contactId) {
            const { error: updateConversationContactError } = await supabase
                .from("conversations")
                .update({
                    contact_id: contactId,
                })
                .eq("id", conversationId)
                .is("contact_id", null);

            if (updateConversationContactError) {
                console.error(
                    "Update conversation contact error:",
                    updateConversationContactError
                );
            }
        }
    } else {
        const { data: conversation, error: conversationError } = await supabase
            .from("conversations")
            .insert({
                business_id: businessId,
                contact_id: contactId,
                channel_id: null,
                status: "open",
                assigned_to: null,
                last_message_at: new Date().toISOString(),
                intent: null,
                urgency: null,
                sentiment: null,
                ai_score: null,
                ai_summary: null,
            })
            .select("id")
            .single();

        if (conversationError || !conversation) {
            console.error("Create conversation error:", conversationError);

            throw new Error(
                conversationError?.message || "Could not create conversation"
            );
        }

        conversationId = conversation.id;

        const { error: webchatSessionError } = await supabase
            .from("webchat_sessions")
            .insert({
                business_id: businessId,
                session_key: sessionId,
                conversation_id: conversationId,
                visitor_name: visitor?.name ?? null,
                visitor_email: visitor?.email ?? null,
                visitor_phone: visitor?.phone ?? null,
            });

        if (webchatSessionError) {
            console.error("Create webchat session error:", webchatSessionError);
            throw new Error(webchatSessionError.message);
        }
    }

    const { error: userMessageError } = await supabase.from("messages").insert({
        business_id: businessId,
        conversation_id: conversationId,
        sender_type: "contact",
        sender_profile_id: null,
        content: message,
        metadata: {
            channel: "webchat",
            sessionId,
            visitor: visitor ?? null,
            contactId,
        },
    });

    if (userMessageError) {
        console.error("Create user message error:", userMessageError);
        throw new Error(userMessageError.message);
    }

    const { data: history, error: historyError } = await supabase
        .from("messages")
        .select("sender_type, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(12);

    if (historyError) {
        console.error("Get message history error:", historyError);
        throw new Error(historyError.message);
    }

    const aiReply = await generateAiReply({
        business,
        history:
            history?.map((item) => ({
                role: item.sender_type === "ai" ? "assistant" : "user",
                content: item.content,
            })) ?? [],
        userMessage: message,
    });

    const analysis = analyzeConversation(message, aiReply);

    const currentAiModel =
        env.AI_PROVIDER === "gemini"
            ? env.GEMINI_MODEL
            : env.AI_PROVIDER === "openai"
                ? "gpt-4.1-mini"
                : "mock";

    const { error: aiMessageError } = await supabase.from("messages").insert({
        business_id: businessId,
        conversation_id: conversationId,
        sender_type: "ai",
        sender_profile_id: null,
        content: aiReply,
        metadata: {
            channel: "webchat",
            model: currentAiModel,
            analysis,
        },
    });

    if (aiMessageError) {
        console.error("Create AI message error:", aiMessageError);
        throw new Error(aiMessageError.message);
    }

    const { error: updateConversationError } = await supabase
        .from("conversations")
        .update({
            last_message_at: new Date().toISOString(),
            contact_id: contactId,
            intent: analysis.intent,
            urgency: analysis.urgency,
            sentiment: analysis.sentiment,
            ai_score: analysis.aiScore,
            ai_summary: analysis.aiSummary,
        })
        .eq("id", conversationId);

    if (updateConversationError) {
        console.error("Update conversation error:", updateConversationError);
    }

    const { error: activityError } = await supabase
        .from("ai_activity_logs")
        .insert({
            business_id: businessId,
            conversation_id: conversationId,
            contact_id: contactId,
            type: "ai_reply",
            status: "success",
            title: "AI replied to web chat message",
            description: aiReply,
            metadata: {
                channel: "webchat",
                input: message,
                output: aiReply,
                model: currentAiModel,
                analysis,
            },
        });

    if (activityError) {
        console.error("Create AI activity log error:", activityError);
    }

    return {
        reply: aiReply,
        conversationId,
        contactId,
        analysis,
    };
}

async function findOrCreateContact(input: {
    businessId: string;
    visitor?: {
        name?: string;
        email?: string;
        phone?: string;
    };
}): Promise<ContactId> {
    const { businessId, visitor } = input;

    const fullName = visitor?.name?.trim() || null;
    const email = visitor?.email?.trim().toLowerCase() || null;
    const phone = visitor?.phone?.trim() || null;

    if (!fullName && !email && !phone) {
        return null;
    }

    let existingContactId: string | null = null;

    if (email) {
        const { data, error } = await supabase
            .from("contacts")
            .select("id")
            .eq("business_id", businessId)
            .eq("email", email)
            .maybeSingle();

        if (error) {
            console.error("Find contact by email error:", error);
        }

        existingContactId = data?.id ?? null;
    }

    if (!existingContactId && phone) {
        const { data, error } = await supabase
            .from("contacts")
            .select("id")
            .eq("business_id", businessId)
            .eq("phone", phone)
            .maybeSingle();

        if (error) {
            console.error("Find contact by phone error:", error);
        }

        existingContactId = data?.id ?? null;
    }

    if (existingContactId) {
        const { error: updateContactError } = await supabase
            .from("contacts")
            .update({
                full_name: fullName,
                email,
                phone,
                source: "webchat",
            })
            .eq("id", existingContactId);

        if (updateContactError) {
            console.error("Update contact error:", updateContactError);
        }

        return existingContactId;
    }

    const { data: contact, error: contactError } = await supabase
        .from("contacts")
        .insert({
            business_id: businessId,
            full_name: fullName ?? "Unknown Contact",
            email,
            phone,
            source: "webchat",
        })
        .select("id")
        .single();

    if (contactError || !contact) {
        console.error("Create contact error:", contactError);
        return null;
    }

    return contact.id as string;
}

function analyzeConversation(
    userMessage: string,
    aiReply: string
): ConversationAnalysis {
    const userText = userMessage.toLowerCase();

    let intent = "general_question";
    let urgency = "normal";
    let sentiment = "neutral";
    let aiScore = 60;

    const isBookingIntent =
        userText.includes("book") ||
        userText.includes("booking") ||
        userText.includes("appointment") ||
        userText.includes("schedule") ||
        userText.includes("available") ||
        userText.includes("availability") ||
        userText.includes("tomorrow") ||
        userText.includes("today") ||
        userText.includes("cita") ||
        userText.includes("agendar") ||
        userText.includes("disponible");

    const isPricingIntent =
        userText.includes("price") ||
        userText.includes("cost") ||
        userText.includes("how much") ||
        userText.includes("quote") ||
        userText.includes("estimate") ||
        userText.includes("pricing") ||
        userText.includes("precio") ||
        userText.includes("cuanto") ||
        userText.includes("cuánto") ||
        userText.includes("cotización");

    const isServiceQuestion =
        userText.includes("service") ||
        userText.includes("services") ||
        userText.includes("what do you do") ||
        userText.includes("what can you do") ||
        userText.includes("what can i do") ||
        userText.includes("help") ||
        userText.includes("servicio") ||
        userText.includes("servicios") ||
        userText.includes("qué hacen") ||
        userText.includes("que hacen");

    if (isPricingIntent) {
        intent = "pricing_question";
        aiScore = 75;
    } else if (isBookingIntent) {
        intent = "booking_request";
        aiScore = 85;
    } else if (isServiceQuestion) {
        intent = "service_question";
        aiScore = 65;
    }

    const isUrgent =
        userText.includes("urgent") ||
        userText.includes("asap") ||
        userText.includes("today") ||
        userText.includes("now") ||
        userText.includes("right now") ||
        userText.includes("ahora") ||
        userText.includes("urgente");

    if (isUrgent) {
        urgency = "high";
        aiScore = Math.max(aiScore, 90);
    }

    const isPositive =
        userText.includes("thank") ||
        userText.includes("thanks") ||
        userText.includes("great") ||
        userText.includes("perfect") ||
        userText.includes("awesome") ||
        userText.includes("excelente") ||
        userText.includes("gracias") ||
        userText.includes("perfecto");

    const isNegative =
        userText.includes("bad") ||
        userText.includes("angry") ||
        userText.includes("problem") ||
        userText.includes("complaint") ||
        userText.includes("malo") ||
        userText.includes("problema") ||
        userText.includes("queja");

    if (isNegative) {
        sentiment = "negative";
    } else if (isPositive) {
        sentiment = "positive";
    }

    return {
        intent,
        urgency,
        sentiment,
        aiScore,
        aiSummary: aiReply.slice(0, 300),
    };
}

// *********************************************
// *********************CONFIG******************
// *********************************************


export async function getPublicWebchatConfig(businessId: string) {
    const { data: channel, error } = await supabase
        .from("channels")
        .select("id, business_id, type, name, status, config")
        .eq("business_id", businessId)
        .eq("type", "webchat")
        .maybeSingle();

    if (error) {
        console.error("Get webchat config error:", error);
        throw new Error(error.message);
    }

    const config = channel?.config as
        | {
            widget_title?: string;
            welcome_message?: string;
            primary_color?: string;
            capture_leads?: boolean;
        }
        | null
        | undefined;

    return {
        businessId,
        channelId: channel?.id ?? null,
        status: channel?.status ?? "inactive",
        widgetTitle: config?.widget_title || "Lumora AI",
        welcomeMessage:
            config?.welcome_message || "Hi! I’m Lumora AI. How can I help you today?",
        primaryColor: config?.primary_color || "#38bdf8",
        captureLeads: config?.capture_leads ?? true,
    };
}