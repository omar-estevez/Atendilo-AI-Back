import { supabase } from "../../config/supabase.js";

type FlowStatus = "active" | "draft" | "paused" | "archived";

type ConversationAnalysis = {
    intent: string;
    urgency?: string;
    sentiment?: string;
    aiScore: number;
    aiSummary?: string;
    needsHuman?: boolean;
};

type AIFlow = {
    id: string;
    business_id: string;
    name: string;
    description: string | null;
    status: FlowStatus;
    trigger_type: string;
    nodes_count: number;
    runs_count: number;
    conversion_rate: number;
    last_run_at: string | null;
    created_at: string;
    updated_at: string;
};

type ExecuteMatchingFlowsInput = {
    businessId: string;
    conversationId: string;
    contactId: string | null;
    analysis: ConversationAnalysis;
    isNewConversation?: boolean;
    followUpRequired?: boolean;
    source?: string;
};

function getMatchingTriggers(input: ExecuteMatchingFlowsInput) {
    const triggers = new Set<string>();

    if (input.isNewConversation) {
        triggers.add("new_conversation");
    }

    if (input.analysis.intent) {
        triggers.add(input.analysis.intent);
    }

    if (
        input.analysis.intent === "human_handoff" ||
        input.analysis.needsHuman === true
    ) {
        triggers.add("human_handoff");
    }

    if (input.analysis.aiScore >= 85) {
        triggers.add("lead_score");
    }

    if (input.followUpRequired) {
        triggers.add("follow_up_required");
    }

    return Array.from(triggers);
}

function getNextConversionRate(flow: AIFlow) {
    const currentRate = Number(flow.conversion_rate || 0);
    const currentRuns = Number(flow.runs_count || 0);
    const nextRuns = currentRuns + 1;

    if (flow.trigger_type === "booking_request") {
        return Math.min(100, currentRate + 5);
    }

    if (flow.trigger_type === "lead_score") {
        return Math.min(100, currentRate + 3);
    }

    return nextRuns <= 1 ? currentRate : currentRate;
}

export async function executeMatchingFlows(input: ExecuteMatchingFlowsInput) {
    const matchingTriggers = getMatchingTriggers(input);

    if (matchingTriggers.length === 0) {
        return [];
    }

    const { data: flows, error: flowsError } = await supabase
        .from("ai_flows")
        .select("*")
        .eq("business_id", input.businessId)
        .eq("status", "active")
        .in("trigger_type", matchingTriggers);

    if (flowsError) {
        console.error("Find matching AI flows error:", flowsError);
        return [];
    }

    if (!flows || flows.length === 0) {
        return [];
    }

    const executedFlows: AIFlow[] = [];

    for (const flow of flows as AIFlow[]) {
        const nextRuns = Number(flow.runs_count || 0) + 1;
        const nextConversionRate = getNextConversionRate(flow);

        const { data: updatedFlow, error: updateFlowError } = await supabase
            .from("ai_flows")
            .update({
                runs_count: nextRuns,
                conversion_rate: nextConversionRate,
                last_run_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("id", flow.id)
            .eq("business_id", input.businessId)
            .select()
            .single();

        if (updateFlowError) {
            console.error("Update AI flow run stats error:", updateFlowError);
            continue;
        }

        const finalFlow = updatedFlow as AIFlow;
        executedFlows.push(finalFlow);

        const { error: activityError } = await supabase
            .from("ai_activity_logs")
            .insert({
                business_id: input.businessId,
                conversation_id: input.conversationId,
                contact_id: input.contactId,
                type: "workflow_triggered",
                status: "success",
                title: `AI Flow triggered: ${finalFlow.name}`,
                description: `The ${finalFlow.name} workflow was triggered by ${finalFlow.trigger_type}.`,
                metadata: {
                    source: input.source || "webchat",
                    flowId: finalFlow.id,
                    flowName: finalFlow.name,
                    triggerType: finalFlow.trigger_type,
                    matchedTriggers: matchingTriggers,
                    analysis: input.analysis,
                },
            });

        if (activityError) {
            console.error("Create AI flow activity log error:", activityError);
        }
    }

    return executedFlows;
}