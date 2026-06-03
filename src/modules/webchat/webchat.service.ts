import { supabase } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { generateAiReply, analyzeConversationWithAI } from "../ai/ai.service.js";
import type {
    WebchatMessageBody,
    EndWebchatSessionBody,
} from "./webchat.controller.js";
import { executeMatchingFlows } from "../ai-flows/ai-flows.service.js";

type ContactId = string | null;
type ConversationStatus = "open" | "pending" | "closed";

type ConversationAnalysis = {
    intent: string;
    urgency: string;
    sentiment: string;
    aiScore: number;
    aiSummary: string;
    needsHuman: boolean;
};

type ChannelConfig = {
    widget_title?: string;
    widgetTitle?: string;
    welcome_message?: string;
    welcomeMessage?: string;
    primary_color?: string;
    primaryColor?: string;
    capture_leads?: boolean;
    captureLeads?: boolean;
    ai_name?: string;
    aiName?: string;
    ai_instructions?: string;
    custom_instructions?: string;
    instructions?: string;
    language?: string;
    tone?: string;
};

function getChannelConfig(config: unknown): ChannelConfig {
    if (!config || typeof config !== "object") {
        return {};
    }

    return config as ChannelConfig;
}

function getAiNameFromChannel(input: {
    channelName?: string | null;
    channelConfig?: ChannelConfig | null;
}) {
    const { channelName, channelConfig } = input;

    return (
        channelConfig?.widget_title ||
        channelConfig?.widgetTitle ||
        channelConfig?.ai_name ||
        channelConfig?.aiName ||
        channelName ||
        "Atendilo AI"
    );
}

function getWelcomeMessage(input: {
    widgetTitle: string;
    channelConfig?: ChannelConfig | null;
}) {
    const { widgetTitle, channelConfig } = input;

    return (
        channelConfig?.welcome_message ||
        channelConfig?.welcomeMessage ||
        `Hi! I’m ${widgetTitle}. How can I help you today?`
    );
}

function getPrimaryColor(channelConfig?: ChannelConfig | null) {
    return (
        channelConfig?.primary_color ||
        channelConfig?.primaryColor ||
        "#38bdf8"
    );
}

function getCaptureLeads(channelConfig?: ChannelConfig | null) {
    return channelConfig?.capture_leads ?? channelConfig?.captureLeads ?? true;
}

function isHumanAgentRequest(text: string) {
    const value = String(text || "").toLowerCase();

    return (
        value.includes("agent") ||
        value.includes("human") ||
        value.includes("person") ||
        value.includes("representative") ||
        value.includes("asesor") ||
        value.includes("agente") ||
        value.includes("persona") ||
        value.includes("humano") ||
        value.includes("alguien real") ||
        value.includes("hablar con alguien") ||
        value.includes("quiero hablar") ||
        value.includes("speak to someone") ||
        value.includes("talk to someone") ||
        value.includes("live agent") ||
        value.includes("real person")
    );
}

function getHumanHandoffReply(userMessage: string, businessName: string) {
    const value = String(userMessage || "").toLowerCase();

    const isSpanish =
        value.includes("agente") ||
        value.includes("asesor") ||
        value.includes("persona") ||
        value.includes("humano") ||
        value.includes("hablar") ||
        value.includes("quiero");

    if (isSpanish) {
        return `El equipo de ${businessName} está trabajando para conectarte con un agente. Por favor, espera un momento.`;
    }

    return `The ${businessName} team is working to connect you with an agent. Please wait a moment.`;
}

function getBusinessName(business: Record<string, any>) {
    return (
        business.name ||
        business.business_name ||
        business.company_name ||
        "the business"
    );
}

function getCurrentAiModel() {
    if (env.AI_PROVIDER === "gemini") return env.GEMINI_MODEL;
    if (env.AI_PROVIDER === "openai") return "gpt-4.1-mini";
    if (env.AI_PROVIDER === "groq") return env.GROQ_MODEL;
    return "mock";
}

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

    const { data: webchatChannel, error: channelError } = await supabase
        .from("channels")
        .select("id, name, status, config")
        .eq("business_id", businessId)
        .eq("type", "webchat")
        .maybeSingle();

    if (channelError) {
        console.error("Find webchat channel error:", channelError);
        throw new Error(channelError.message);
    }

    if (!webchatChannel || webchatChannel.status !== "active") {
        throw new Error("Web Chat is currently inactive.");
    }

    const channelConfig = getChannelConfig(webchatChannel.config);

    const aiName = getAiNameFromChannel({
        channelName: webchatChannel.name,
        channelConfig,
    });

    const businessName = getBusinessName(business);

    const contactId = await findOrCreateContact({
        businessId,
        visitor,
    });

    let conversationId: string;
    let currentConversationStatus: ConversationStatus = "open";

    let isNewConversation = false;

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

        const { data: currentConversation, error: currentConversationError } =
            await supabase
                .from("conversations")
                .select("status")
                .eq("id", conversationId)
                .eq("business_id", businessId)
                .maybeSingle();

        if (currentConversationError) {
            console.error(
                "Find current conversation status error:",
                currentConversationError
            );
        }

        currentConversationStatus =
            (currentConversation?.status as ConversationStatus) || "open";

        const conversationUpdate: Record<string, unknown> = {
            channel_id: webchatChannel.id,
        };

        if (contactId) {
            conversationUpdate.contact_id = contactId;
        }

        const { error: updateConversationContactError } = await supabase
            .from("conversations")
            .update(conversationUpdate)
            .eq("id", conversationId)
            .eq("business_id", businessId);

        if (updateConversationContactError) {
            console.error(
                "Update conversation contact/channel error:",
                updateConversationContactError
            );
        }
    } else {
        const { data: conversation, error: conversationError } = await supabase
            .from("conversations")
            .insert({
                business_id: businessId,
                contact_id: contactId,
                channel_id: webchatChannel.id,
                status: "open",
                assigned_to: null,
                last_message_at: new Date().toISOString(),
                intent: null,
                urgency: null,
                sentiment: null,
                ai_score: null,
                ai_summary: null,
                needs_human: false,
                ai_analyzed_at: null,
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
        currentConversationStatus = "open";

        isNewConversation = true;

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

    if (currentConversationStatus === "closed") {
        throw new Error("This conversation is closed.");
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
            clientMessageId: input.clientMessageId ?? null,
        },
    });

    if (userMessageError) {
        console.error("Create user message error:", userMessageError);
        throw new Error(userMessageError.message);
    }

    const customerRequestedAgent = isHumanAgentRequest(message);

    if (customerRequestedAgent || currentConversationStatus === "pending") {
        const handoffReply = customerRequestedAgent
            ? getHumanHandoffReply(message, businessName)
            : null;

        if (handoffReply) {
            const { error: handoffMessageError } = await supabase
                .from("messages")
                .insert({
                    business_id: businessId,
                    conversation_id: conversationId,
                    sender_type: "ai",
                    sender_profile_id: null,
                    content: handoffReply,
                    metadata: {
                        channel: "webchat",
                        type: "human_handoff",
                        sessionId,
                        aiName,
                    },
                });

            if (handoffMessageError) {
                console.error(
                    "Create human handoff message error:",
                    handoffMessageError
                );
                throw new Error(handoffMessageError.message);
            }
        }

        const aiSummary =
            handoffReply || "Customer is waiting for a human agent response.";

        const { error: updatePendingError } = await supabase
            .from("conversations")
            .update({
                status: "pending",
                last_message_at: new Date().toISOString(),
                contact_id: contactId,
                channel_id: webchatChannel.id,
                intent: "human_handoff",
                urgency: "normal",
                sentiment: "neutral",
                ai_score: 90,
                ai_summary: aiSummary,
                needs_human: true,
                ai_analyzed_at: new Date().toISOString(),
            })
            .eq("id", conversationId)
            .eq("business_id", businessId);

        if (updatePendingError) {
            console.error(
                "Update conversation to pending error:",
                updatePendingError
            );
            throw new Error(updatePendingError.message);
        }

        const analysis: ConversationAnalysis = {
            intent: "human_handoff",
            urgency: "normal",
            sentiment: "neutral",
            aiScore: 90,
            aiSummary,
            needsHuman: true,
        };

        const { error: activityError } = await supabase
            .from("ai_activity_logs")
            .insert({
                business_id: businessId,
                conversation_id: conversationId,
                contact_id: contactId,
                type: "handoff",
                status: "success",
                title: "Customer requested human agent",
                description: aiSummary,
                metadata: {
                    channel: "webchat",
                    input: message,
                    output: handoffReply,
                    aiName,
                    analysis,
                },
            });

        if (activityError) {
            console.error("Create handoff activity log error:", activityError);
        }

        await executeMatchingFlows({
            businessId,
            conversationId,
            contactId,
            analysis: {
                ...analysis,
                needsHuman: true,
            },
            isNewConversation,
            followUpRequired: false,
            source: "webchat",
        });

        return {
            reply: handoffReply,
            conversationId,
            contactId,
            status: "pending",
            analysis,
        };
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
        aiName,
        channelConfig,
        history:
            history?.map((item) => ({
                role:
                    item.sender_type === "contact"
                        ? ("user" as const)
                        : ("assistant" as const),
                content: item.content,
            })) ?? [],
        userMessage: message,
    });

    const analysis = await analyzeConversationWithAI({
        business,
        aiName,
        channelConfig,
        history:
            history?.map((item) => ({
                role: item.sender_type === "contact" ? ("user" as const) : ("assistant" as const),
                content: item.content,
            })) ?? [],
        userMessage: message,
        aiReply,
    });

    const currentAiModel = getCurrentAiModel();

    const { error: aiMessageError } = await supabase.from("messages").insert({
        business_id: businessId,
        conversation_id: conversationId,
        sender_type: "ai",
        sender_profile_id: null,
        content: aiReply,
        metadata: {
            channel: "webchat",
            model: currentAiModel,
            aiName,
            analysis,
        },
    });

    if (aiMessageError) {
        console.error("Create AI message error:", aiMessageError);
        throw new Error(aiMessageError.message);
    }

    const nextStatus: ConversationStatus = analysis.needsHuman ? "pending" : "open";

    const { error: updateConversationError } = await supabase
        .from("conversations")
        .update({
            status: nextStatus,
            last_message_at: new Date().toISOString(),
            contact_id: contactId,
            channel_id: webchatChannel.id,
            intent: analysis.intent,
            urgency: analysis.urgency,
            sentiment: analysis.sentiment,
            ai_score: analysis.aiScore,
            ai_summary: analysis.aiSummary,
            needs_human: analysis.needsHuman,
            ai_analyzed_at: new Date().toISOString(),
        })
        .eq("id", conversationId)
        .eq("business_id", businessId);

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
            title: `${aiName} replied to web chat message`,
            description: aiReply,
            metadata: {
                channel: "webchat",
                input: message,
                output: aiReply,
                model: currentAiModel,
                aiName,
                analysis,
            },
        });

    if (activityError) {
        console.error("Create AI activity log error:", activityError);
    }

    await executeMatchingFlows({
        businessId,
        conversationId,
        contactId,
        analysis: {
            ...analysis,
            needsHuman: analysis.intent === "human_handoff",
        },
        isNewConversation,
        followUpRequired: false,
        source: "webchat",
    });

    return { reply: aiReply, conversationId, contactId, status: nextStatus, analysis };
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
        const updatePayload: Record<string, string | null> = {
            source: "webchat",
        };

        if (fullName) updatePayload.full_name = fullName;
        if (email) updatePayload.email = email;
        if (phone) updatePayload.phone = phone;

        const { error: updateContactError } = await supabase
            .from("contacts")
            .update(updatePayload)
            .eq("id", existingContactId)
            .eq("business_id", businessId);

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

export async function getWebchatMessages(input: {
    businessId: string;
    sessionId: string;
}) {
    const { businessId, sessionId } = input;

    const { data: existingSession, error: sessionError } = await supabase
        .from("webchat_sessions")
        .select("conversation_id")
        .eq("business_id", businessId)
        .eq("session_key", sessionId)
        .maybeSingle();

    if (sessionError) {
        console.error("Find webchat session messages error:", sessionError);
        throw new Error(sessionError.message);
    }

    if (!existingSession?.conversation_id) {
        return {
            conversationId: null,
            status: null,
            messages: [],
        };
    }

    const { data: conversation, error: conversationError } = await supabase
        .from("conversations")
        .select("id, status")
        .eq("id", existingSession.conversation_id)
        .eq("business_id", businessId)
        .maybeSingle();

    if (conversationError) {
        console.error("Get webchat conversation status error:", conversationError);
        throw new Error(conversationError.message);
    }

    if (!conversation) {
        return {
            conversationId: existingSession.conversation_id,
            status: null,
            messages: [],
        };
    }

    const { data: messages, error: messagesError } = await supabase
        .from("messages")
        .select("id, sender_type, content, created_at, metadata")
        .eq("business_id", businessId)
        .eq("conversation_id", existingSession.conversation_id)
        .order("created_at", { ascending: true });

    if (messagesError) {
        console.error("Get webchat messages error:", messagesError);
        throw new Error(messagesError.message);
    }

    return {
        conversationId: existingSession.conversation_id,
        status: conversation.status,
        messages: messages ?? [],
    };
}

export async function endWebchatSession(input: EndWebchatSessionBody) {
    const { businessId, sessionId, reason = "user" } = input;

    const { data: existingSession, error: sessionError } = await supabase
        .from("webchat_sessions")
        .select("conversation_id")
        .eq("business_id", businessId)
        .eq("session_key", sessionId)
        .maybeSingle();

    if (sessionError) {
        console.error("Find webchat session to end error:", sessionError);
        throw new Error(sessionError.message);
    }

    if (!existingSession?.conversation_id) {
        return {
            ended: false,
            reason: "session_not_found",
        };
    }

    const { error: updateConversationError } = await supabase
        .from("conversations")
        .update({
            status: "closed",
            last_message_at: new Date().toISOString(),
        })
        .eq("id", existingSession.conversation_id)
        .eq("business_id", businessId);

    if (updateConversationError) {
        console.error("Close webchat conversation error:", updateConversationError);
        throw new Error(updateConversationError.message);
    }

    return {
        ended: true,
        conversationId: existingSession.conversation_id,
        reason,
    };
}

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

    const config = getChannelConfig(channel?.config);

    const widgetTitle = getAiNameFromChannel({
        channelName: channel?.name,
        channelConfig: config,
    });

    return {
        businessId,
        channelId: channel?.id ?? null,
        status: channel?.status ?? "inactive",
        widgetTitle,
        welcomeMessage: getWelcomeMessage({
            widgetTitle,
            channelConfig: config,
        }),
        primaryColor: getPrimaryColor(config),
        captureLeads: getCaptureLeads(config),
    };
}