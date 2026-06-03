// src/modules/bookings/booking-automation.service.ts

import { supabase } from "../../config/supabase.js";
import { extractBookingDetailsWithAI } from "../ai/ai.service.js";
import { getContactProfile } from "../webchat/webchat.service.js";

type BookingAutomationInput = {
    businessId: string;
    conversationId: string;
    contactId: string | null;
    message: string;
    aiReply: string;
    analysis: {
        intent: string;
        aiScore: number;
        aiSummary?: string;
    };
};

type BookingStatus = "pending" | "confirmed" | "completed" | "cancelled";

function addMinutes(date: Date, minutes: number) {
    return new Date(date.getTime() + minutes * 60 * 1000);
}

async function getConversationHistory(conversationId: string) {
    const { data, error } = await supabase
        .from("messages")
        .select("sender_type, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(30);

    if (error) {
        console.error("Get booking history error:", error);
        return [];
    }

    return data || [];
}

async function updateOrCreateBookingContact(input: {
    businessId: string;
    currentContactId: string | null;
    conversationId: string;
    customerName?: string | null;
    email?: string | null;
    phone?: string | null;
}) {
    const customerName = input.customerName?.trim() || null;
    const email = input.email?.trim().toLowerCase() || null;
    const phone = input.phone?.trim() || null;

    if (!customerName && !email && !phone) {
        return input.currentContactId;
    }

    let contactId = input.currentContactId;

    if (!contactId && email) {
        const { data } = await supabase
            .from("contacts")
            .select("id")
            .eq("business_id", input.businessId)
            .eq("email", email)
            .maybeSingle();

        contactId = data?.id || null;
    }

    if (!contactId && phone) {
        const { data } = await supabase
            .from("contacts")
            .select("id")
            .eq("business_id", input.businessId)
            .eq("phone", phone)
            .maybeSingle();

        contactId = data?.id || null;
    }

    if (contactId) {
        const updatePayload: Record<string, unknown> = {
            source: "webchat",
        };

        if (customerName) updatePayload.full_name = customerName;
        if (email) updatePayload.email = email;
        if (phone) updatePayload.phone = phone;

        const { error } = await supabase
            .from("contacts")
            .update(updatePayload)
            .eq("id", contactId)
            .eq("business_id", input.businessId);

        if (error) {
            console.error("Update booking contact error:", error);
        }

        await supabase
            .from("conversations")
            .update({
                contact_id: contactId,
            })
            .eq("id", input.conversationId)
            .eq("business_id", input.businessId);

        return contactId;
    }

    const { data: newContact, error: createError } = await supabase
        .from("contacts")
        .insert({
            business_id: input.businessId,
            full_name: customerName || "Unknown Contact",
            email,
            phone,
            source: "webchat",
        })
        .select("id")
        .single();

    if (createError || !newContact) {
        console.error("Create booking contact error:", createError);
        return input.currentContactId;
    }

    await supabase
        .from("conversations")
        .update({
            contact_id: newContact.id,
        })
        .eq("id", input.conversationId)
        .eq("business_id", input.businessId);

    return newContact.id as string;
}

async function isBookingSlotAvailable(input: {
    businessId: string;
    scheduledAt: string;
    durationMinutes?: number;
}) {
    const start = new Date(input.scheduledAt);
    const end = addMinutes(start, input.durationMinutes || 60);

    const { data, error } = await supabase
        .from("bookings")
        .select("id, scheduled_at, status")
        .eq("business_id", input.businessId)
        .in("status", ["pending", "confirmed"])
        .gte("scheduled_at", start.toISOString())
        .lt("scheduled_at", end.toISOString());

    if (error) {
        console.error("Check booking availability error:", error);
        return {
            available: false,
            reason: "availability_check_failed",
        };
    }

    return {
        available: !data || data.length === 0,
        reason: data && data.length > 0 ? "slot_taken" : null,
    };
}

async function bookingAlreadyExists(input: {
    businessId: string;
    conversationId: string;
}) {
    const { data, error } = await supabase
        .from("bookings")
        .select("id")
        .eq("business_id", input.businessId)
        .eq("conversation_id", input.conversationId)
        .in("status", ["pending", "confirmed"])
        .maybeSingle();

    if (error) {
        console.error("Find existing booking error:", error);
    }

    return data?.id || null;
}

export async function processBookingAutomation(input: BookingAutomationInput) {
    const shouldCheckBooking =
        input.analysis.intent === "booking_request" ||
        input.analysis.intent === "booking_ready" ||
        input.message.toLowerCase().includes("book") ||
        input.message.toLowerCase().includes("booking") ||
        input.message.toLowerCase().includes("appointment") ||
        input.message.toLowerCase().includes("schedule") ||
        input.message.toLowerCase().includes("cita") ||
        input.message.toLowerCase().includes("agendar") ||
        input.message.toLowerCase().includes("yes") ||
        input.message.toLowerCase().includes("confirm") ||
        input.message.toLowerCase().includes("sí") ||
        input.message.toLowerCase().includes("si");

    if (!shouldCheckBooking) {
        return {
            created: false,
            reason: "not_booking_related",
        };
    }

    const existingBookingId = await bookingAlreadyExists({
        businessId: input.businessId,
        conversationId: input.conversationId,
    });

    if (existingBookingId) {
        return {
            created: false,
            reason: "booking_already_exists",
            bookingId: existingBookingId,
        };
    }

    const history = await getConversationHistory(input.conversationId);

    const contactProfile = await getContactProfile(input.contactId);

    const extracted = await extractBookingDetailsWithAI({
        currentDateIso: new Date().toISOString(),
        customerProfile: contactProfile,
        messages: history.map((item) => ({
            senderType: item.sender_type,
            content: item.content,
        })),
    });

    if (!extracted.isBookingIntent) {
        return {
            created: false,
            reason: "ai_not_booking_intent",
            extracted,
        };
    }

    const updatedContactId = await updateOrCreateBookingContact({
        businessId: input.businessId,
        currentContactId: input.contactId,
        conversationId: input.conversationId,
        customerName: extracted.customerName,
        email: extracted.email,
        phone: extracted.phone,
    });

    const fallbackCustomerName =
        extracted.customerName || (await getContactFallbackName(updatedContactId));

    if (!extracted.isConfirmed) {
        return {
            created: false,
            reason: "waiting_for_confirmation",
            extracted,
            contactId: updatedContactId,
        };
    }

    if (!fallbackCustomerName || !extracted.serviceName || !extracted.scheduledAt) {
        return {
            created: false,
            reason: "missing_required_booking_data",
            extracted,
            contactId: updatedContactId,
        };
    }

    const availability = await isBookingSlotAvailable({
        businessId: input.businessId,
        scheduledAt: extracted.scheduledAt,
        durationMinutes: 60,
    });

    if (!availability.available) {
        await supabase.from("ai_activity_logs").insert({
            business_id: input.businessId,
            conversation_id: input.conversationId,
            contact_id: updatedContactId,
            type: "workflow_triggered",
            status: "warning",
            title: "Booking slot unavailable",
            description:
                "The requested booking time is already taken. AI should suggest another time.",
            metadata: {
                source: "booking_automation",
                requestedScheduledAt: extracted.scheduledAt,
                availability,
                extracted,
            },
        });

        return {
            created: false,
            reason: "slot_unavailable",
            extracted,
            contactId: updatedContactId,
        };
    }

    const { data: booking, error: bookingError } = await supabase
        .from("bookings")
        .insert({
            business_id: input.businessId,
            contact_id: updatedContactId,
            conversation_id: input.conversationId,
            customer_name: fallbackCustomerName,
            service_name: extracted.serviceName,
            scheduled_at: extracted.scheduledAt,
            status: "pending" satisfies BookingStatus,
            estimated_value: extracted.estimatedValue || 0,
            notes: extracted.notes || input.analysis.aiSummary || null,
            source: "ai_flow",
        })
        .select("*")
        .single();

    if (bookingError || !booking) {
        console.error("Create automated booking error:", bookingError);

        return {
            created: false,
            reason: "booking_create_failed",
            error: bookingError?.message,
            extracted,
            contactId: updatedContactId,
        };
    }

    await supabase.from("ai_activity_logs").insert({
        business_id: input.businessId,
        conversation_id: input.conversationId,
        contact_id: updatedContactId,
        type: "appointment_scheduled",
        status: "success",
        title: "Booking created by AI",
        description: `${fallbackCustomerName} requested ${extracted.serviceName}. Booking is pending confirmation.`,
        metadata: {
            source: "booking_automation",
            bookingId: booking.id,
            extracted,
            booking,
        },
    });

    return {
        created: true,
        reason: "booking_created",
        booking,
        contactId: updatedContactId,
    };
}

async function getContactFallbackName(contactId: string | null) {
    if (!contactId) return null;

    const { data, error } = await supabase
        .from("contacts")
        .select("full_name, email, phone")
        .eq("id", contactId)
        .maybeSingle();

    if (error) {
        console.error("Get contact fallback name error:", error);
        return null;
    }

    return data?.full_name || data?.email || data?.phone || null;
}