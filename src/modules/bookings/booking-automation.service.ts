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

type BusinessRecord = Record<string, any>;

type SuggestedBookingSlot = {
    scheduledAt: string;
};

const DEFAULT_BOOKING_DURATION_MINUTES = 60;
const SLOT_STEP_MINUTES = 30;
const MAX_SUGGESTED_SLOTS = 3;

function getBusinessSettings(business?: BusinessRecord | null) {
    if (!business?.settings || typeof business.settings !== "object") {
        return {};
    }

    return business.settings as Record<string, any>;
}

function getBusinessTimezone(business?: BusinessRecord | null) {
    const settings = getBusinessSettings(business);

    return (
        business?.timezone ||
        settings.timezone ||
        settings.businessTimezone ||
        "America/Chicago"
    );
}

function getBusinessHours(business?: BusinessRecord | null) {
    const settings = getBusinessSettings(business);

    return Array.isArray(settings.businessHours) ? settings.businessHours : [];
}

function getBookingRules(business?: BusinessRecord | null) {
    const settings = getBusinessSettings(business);

    if (!settings.bookingRules || typeof settings.bookingRules !== "object") {
        return {};
    }

    return settings.bookingRules as Record<string, any>;
}

function parseMinutesFromValue(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (!value) return 0;

    const text = String(value).toLowerCase().trim();
    const numberMatch = text.match(/\d+(\.\d+)?/);
    const amount = numberMatch ? Number(numberMatch[0]) : 0;

    if (!amount) return 0;

    if (text.includes("day") || text.includes("día") || text.includes("dia")) {
        return amount * 24 * 60;
    }

    if (
        text.includes("hour") ||
        text.includes("hora") ||
        text.includes("hr") ||
        text.includes(" h")
    ) {
        return amount * 60;
    }

    return amount;
}

function getMinimumNoticeMinutes(business?: BusinessRecord | null) {
    const bookingRules = getBookingRules(business);

    return parseMinutesFromValue(
        bookingRules.minimumNotice ||
        bookingRules.minimum_notice ||
        bookingRules.minNotice
    );
}

function getTimeZoneParts(date: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });

    const map: Record<string, string> = {};

    for (const part of formatter.formatToParts(date)) {
        if (part.type !== "literal") {
            map[part.type] = part.value;
        }
    }

    return {
        weekday: map.weekday,
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second || "0"),
    };
}

function getDateKeyInTimeZone(date: Date, timeZone: string) {
    const parts = getTimeZoneParts(date, timeZone);

    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
        parts.day
    ).padStart(2, "0")}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));

    return date.toISOString().slice(0, 10);
}

function normalizeWeekday(value: unknown) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .slice(0, 3);
}

function parseBusinessTime(value: unknown) {
    if (!value) return null;

    const text = String(value).trim().toLowerCase();
    const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);

    if (!match) return null;

    let hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const period = match[3];

    if (period === "pm" && hour < 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    return { hour, minute };
}

function zonedTimeToUtc(dateKey: string, timeValue: unknown, timeZone: string) {
    const parsedTime = parseBusinessTime(timeValue);

    if (!parsedTime) return null;

    const [year, month, day] = dateKey.split("-").map(Number);

    const utcGuess = new Date(
        Date.UTC(year, month - 1, day, parsedTime.hour, parsedTime.minute, 0)
    );

    const zonedParts = getTimeZoneParts(utcGuess, timeZone);

    const zonedAsUtc = Date.UTC(
        zonedParts.year,
        zonedParts.month - 1,
        zonedParts.day,
        zonedParts.hour,
        zonedParts.minute,
        zonedParts.second
    );

    const desiredAsUtc = Date.UTC(
        year,
        month - 1,
        day,
        parsedTime.hour,
        parsedTime.minute,
        0
    );

    return new Date(utcGuess.getTime() - (zonedAsUtc - desiredAsUtc));
}

function getBusinessHoursForDateKey(
    business: BusinessRecord | null,
    dateKey: string,
    timeZone: string
) {
    const businessHours = getBusinessHours(business);

    if (!businessHours.length) return null;

    const noonUtc = zonedTimeToUtc(dateKey, "12:00", timeZone);

    if (!noonUtc) return null;

    const weekday = normalizeWeekday(getTimeZoneParts(noonUtc, timeZone).weekday);

    const dayHours = businessHours.find((item: Record<string, any>) => {
        return normalizeWeekday(item.day || item.weekday || item.name) === weekday;
    });

    if (!dayHours || !dayHours.enabled) {
        return {
            enabled: false,
            open: null,
            close: null,
        };
    }

    return {
        enabled: true,
        open: dayHours.open,
        close: dayHours.close,
    };
}

function isSlotInsideBusinessHours(input: {
    business: BusinessRecord | null;
    scheduledAt: string;
    durationMinutes: number;
}) {
    const businessHours = getBusinessHours(input.business);

    if (!businessHours.length) {
        return {
            inside: true,
            reason: null,
        };
    }

    const timeZone = getBusinessTimezone(input.business);
    const start = new Date(input.scheduledAt);
    const end = addMinutes(start, input.durationMinutes);
    const dateKey = getDateKeyInTimeZone(start, timeZone);
    const dayHours = getBusinessHoursForDateKey(input.business, dateKey, timeZone);

    if (!dayHours || !dayHours.enabled) {
        return {
            inside: false,
            reason: "outside_business_hours",
        };
    }

    const openUtc = zonedTimeToUtc(dateKey, dayHours.open, timeZone);
    let closeUtc = zonedTimeToUtc(dateKey, dayHours.close, timeZone);

    if (!openUtc || !closeUtc) {
        return {
            inside: true,
            reason: null,
        };
    }

    if (closeUtc.getTime() <= openUtc.getTime()) {
        closeUtc = addMinutes(closeUtc, 24 * 60);
    }

    return {
        inside:
            start.getTime() >= openUtc.getTime() &&
            end.getTime() <= closeUtc.getTime(),
        reason:
            start.getTime() >= openUtc.getTime() &&
                end.getTime() <= closeUtc.getTime()
                ? null
                : "outside_business_hours",
    };
}

function normalizeText(value: unknown) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\w\s+]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getServiceDurationMinutes(
    business: BusinessRecord | null,
    serviceName: unknown,
    fallback = DEFAULT_BOOKING_DURATION_MINUTES
) {
    const settings = getBusinessSettings(business);
    const services = Array.isArray(settings.services) ? settings.services : [];
    const normalizedServiceName = normalizeText(serviceName);

    const matchedService = services.find((service: Record<string, any>) => {
        const serviceTitle = normalizeText(service.name || service.title);

        if (!serviceTitle || !normalizedServiceName) return false;

        return (
            serviceTitle === normalizedServiceName ||
            normalizedServiceName.includes(serviceTitle) ||
            serviceTitle.includes(normalizedServiceName)
        );
    });

    const duration = Number(
        matchedService?.durationMinutes ||
        matchedService?.duration_minutes ||
        matchedService?.duration
    );

    return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function roundUpToStep(date: Date, stepMinutes: number) {
    const stepMs = stepMinutes * 60 * 1000;

    return new Date(Math.ceil(date.getTime() / stepMs) * stepMs);
}

function formatSlotLabel(date: Date, business: BusinessRecord | null, spanish: boolean) {
    const timeZone = getBusinessTimezone(business);

    return new Intl.DateTimeFormat(spanish ? "es-US" : "en-US", {
        timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}

function isSpanishMessage(message: string) {
    return /\b(hola|quiero|necesito|cita|agendar|reservar|disponible|mañana|manana|gracias|sí|si)\b/i.test(
        message
    );
}

async function getBusinessForBookingAutomation(businessId: string) {
    const { data, error } = await supabase
        .from("businesses")
        .select("*")
        .eq("id", businessId)
        .maybeSingle();

    if (error) {
        console.error("Get business for booking automation error:", error);
        return null;
    }

    return data || null;
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
    business: BusinessRecord | null;
    scheduledAt: string;
    durationMinutes?: number | null;
}) {
    const start = new Date(input.scheduledAt);

    if (Number.isNaN(start.getTime())) {
        return {
            available: false,
            reason: "invalid_booking_date",
        };
    }

    const durationMinutes =
        input.durationMinutes || DEFAULT_BOOKING_DURATION_MINUTES;

    const end = addMinutes(start, durationMinutes);

    const businessHoursCheck = isSlotInsideBusinessHours({
        business: input.business,
        scheduledAt: input.scheduledAt,
        durationMinutes,
    });

    if (!businessHoursCheck.inside) {
        return {
            available: false,
            reason: businessHoursCheck.reason || "outside_business_hours",
        };
    }

    const searchStart = addMinutes(start, -12 * 60);

    const { data, error } = await supabase
        .from("bookings")
        .select("id, scheduled_at, status, service_name")
        .eq("business_id", input.businessId)
        .in("status", ["pending", "confirmed"])
        .gte("scheduled_at", searchStart.toISOString())
        .lt("scheduled_at", end.toISOString());

    if (error) {
        console.error("Check booking availability error:", error);

        return {
            available: false,
            reason: "availability_check_failed",
        };
    }

    const conflictingBooking = (data || []).find((booking: any) => {
        const existingStart = new Date(booking.scheduled_at);

        if (Number.isNaN(existingStart.getTime())) return false;

        const existingDuration = getServiceDurationMinutes(
            input.business,
            booking.service_name,
            DEFAULT_BOOKING_DURATION_MINUTES
        );

        const existingEnd = addMinutes(existingStart, existingDuration);

        return existingStart.getTime() < end.getTime() && existingEnd.getTime() > start.getTime();
    });

    return {
        available: !conflictingBooking,
        reason: conflictingBooking ? "slot_taken" : null,
        conflictingBookingId: conflictingBooking?.id || null,
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
    const lowerMessage = input.message.toLowerCase();

    const shouldCheckBooking =
        input.analysis.intent === "booking_request" ||
        input.analysis.intent === "booking_ready" ||
        lowerMessage.includes("book") ||
        lowerMessage.includes("booking") ||
        lowerMessage.includes("appointment") ||
        lowerMessage.includes("schedule") ||
        lowerMessage.includes("reserve") ||
        lowerMessage.includes("availability") ||
        lowerMessage.includes("cita") ||
        lowerMessage.includes("agendar") ||
        lowerMessage.includes("reservar") ||
        lowerMessage.includes("disponible") ||
        lowerMessage.includes("yes") ||
        lowerMessage.includes("confirm") ||
        lowerMessage.includes("you have my data") ||
        lowerMessage.includes("you have my info") ||
        lowerMessage.includes("ya tienes mis datos") ||
        lowerMessage.includes("ya tienes mi información") ||
        lowerMessage.includes("sí") ||
        lowerMessage.includes("si");

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

    const business = await getBusinessForBookingAutomation(input.businessId);
    const history = await getConversationHistory(input.conversationId);
    const contactProfile = await getContactProfile(input.contactId);

    const extracted = await extractBookingDetailsWithAI({
        business,
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

    const hasContactIdentifier =
        Boolean(fallbackCustomerName) ||
        Boolean(extracted.email) ||
        Boolean(extracted.phone);

    if (!hasContactIdentifier || !extracted.serviceName || !extracted.scheduledAt) {
        return {
            created: false,
            reason: "missing_required_booking_data",
            extracted,
            contactId: updatedContactId,
        };
    }

    const bookingDurationMinutes =
        extracted.durationMinutes ||
        getServiceDurationMinutes(
            business,
            extracted.serviceName,
            DEFAULT_BOOKING_DURATION_MINUTES
        );

    const availability = await isBookingSlotAvailable({
        businessId: input.businessId,
        business,
        scheduledAt: extracted.scheduledAt,
        durationMinutes: bookingDurationMinutes,
    });

    if (!availability.available) {
        const suggestedSlots = await findAvailableBookingSlots({
            businessId: input.businessId,
            business,
            requestedScheduledAt: extracted.scheduledAt,
            durationMinutes: bookingDurationMinutes,
            limit: MAX_SUGGESTED_SLOTS,
        });

        const replyOverride = buildSlotUnavailableReply({
            message: input.message,
            business,
            requestedScheduledAt: extracted.scheduledAt,
            suggestedSlots,
            reason: availability.reason,
        });

        await supabase.from("ai_activity_logs").insert({
            business_id: input.businessId,
            conversation_id: input.conversationId,
            contact_id: updatedContactId,
            type: "workflow_triggered",
            status: "warning",
            title:
                availability.reason === "outside_business_hours"
                    ? "Booking outside business hours"
                    : "Booking slot unavailable",
            description:
                availability.reason === "outside_business_hours"
                    ? "The requested booking time is outside business hours. AI suggested available business-hour slots."
                    : "The requested booking time is already taken. AI suggested another available time.",
            metadata: {
                source: "booking_automation",
                requestedScheduledAt: extracted.scheduledAt,
                suggestedSlots,
                availability,
                extracted,
            },
        });

        return {
            created: false,
            reason: availability.reason || "slot_unavailable",
            extracted,
            contactId: updatedContactId,
            suggestedSlots,
            replyOverride,
        };
    }

    async function findAvailableBookingSlots(input: {
        businessId: string;
        business: BusinessRecord | null;
        requestedScheduledAt: string;
        durationMinutes?: number | null;
        limit?: number;
    }): Promise<SuggestedBookingSlot[]> {
        const requestedDate = new Date(input.requestedScheduledAt);

        if (Number.isNaN(requestedDate.getTime())) return [];

        const business = input.business;
        const timeZone = getBusinessTimezone(business);
        const businessHours = getBusinessHours(business);
        const durationMinutes =
            input.durationMinutes || DEFAULT_BOOKING_DURATION_MINUTES;

        const limit = input.limit || MAX_SUGGESTED_SLOTS;
        const minimumNoticeMinutes = getMinimumNoticeMinutes(business);
        const earliestAllowed = addMinutes(new Date(), minimumNoticeMinutes);
        const requestedPlusStep = addMinutes(requestedDate, SLOT_STEP_MINUTES);

        const suggestedSlots: SuggestedBookingSlot[] = [];

        if (!businessHours.length) {
            let candidate = roundUpToStep(
                new Date(
                    Math.max(requestedPlusStep.getTime(), earliestAllowed.getTime())
                ),
                SLOT_STEP_MINUTES
            );

            for (let attempt = 0; attempt < 48 && suggestedSlots.length < limit; attempt++) {
                const availability = await isBookingSlotAvailable({
                    businessId: input.businessId,
                    business,
                    scheduledAt: candidate.toISOString(),
                    durationMinutes,
                });

                if (availability.available) {
                    suggestedSlots.push({
                        scheduledAt: candidate.toISOString(),
                    });
                }

                candidate = addMinutes(candidate, SLOT_STEP_MINUTES);
            }

            return suggestedSlots;
        }

        const baseDateKey = getDateKeyInTimeZone(requestedDate, timeZone);

        for (let dayOffset = 0; dayOffset < 10 && suggestedSlots.length < limit; dayOffset++) {
            const dateKey = addDaysToDateKey(baseDateKey, dayOffset);
            const dayHours = getBusinessHoursForDateKey(business, dateKey, timeZone);

            if (!dayHours || !dayHours.enabled) continue;

            const openUtc = zonedTimeToUtc(dateKey, dayHours.open, timeZone);
            let closeUtc = zonedTimeToUtc(dateKey, dayHours.close, timeZone);

            if (!openUtc || !closeUtc) continue;

            if (closeUtc.getTime() <= openUtc.getTime()) {
                closeUtc = addMinutes(closeUtc, 24 * 60);
            }

            const earliestCandidate =
                dayOffset === 0
                    ? new Date(
                        Math.max(
                            openUtc.getTime(),
                            requestedPlusStep.getTime(),
                            earliestAllowed.getTime()
                        )
                    )
                    : new Date(Math.max(openUtc.getTime(), earliestAllowed.getTime()));

            let candidate = roundUpToStep(earliestCandidate, SLOT_STEP_MINUTES);

            while (
                addMinutes(candidate, durationMinutes).getTime() <= closeUtc.getTime() &&
                suggestedSlots.length < limit
            ) {
                const availability = await isBookingSlotAvailable({
                    businessId: input.businessId,
                    business,
                    scheduledAt: candidate.toISOString(),
                    durationMinutes,
                });

                if (
                    availability.available &&
                    candidate.getTime() !== requestedDate.getTime()
                ) {
                    suggestedSlots.push({
                        scheduledAt: candidate.toISOString(),
                    });
                }

                candidate = addMinutes(candidate, SLOT_STEP_MINUTES);
            }
        }

        return suggestedSlots;
    }

    function buildSlotUnavailableReply(input: {
        message: string;
        business: BusinessRecord | null;
        requestedScheduledAt: string;
        suggestedSlots: SuggestedBookingSlot[];
        reason?: string | null;
    }) {
        const spanish = isSpanishMessage(input.message);
        const requestedDate = new Date(input.requestedScheduledAt);
        const requestedLabel = Number.isNaN(requestedDate.getTime())
            ? null
            : formatSlotLabel(requestedDate, input.business, spanish);

        const suggestions = input.suggestedSlots
            .map((slot) => formatSlotLabel(new Date(slot.scheduledAt), input.business, spanish))
            .filter(Boolean);

        const outsideHours = input.reason === "outside_business_hours";

        if (spanish) {
            const reasonText = outsideHours
                ? "Ese horario está fuera del horario del negocio"
                : "Ese horario ya no está disponible";

            if (!suggestions.length) {
                return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""}. No encontré otro horario disponible dentro del horario del negocio por ahora. ¿Qué otro día u hora te funciona?`;
            }

            return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""}. Tengo estos horarios disponibles:\n\n${suggestions
                .map((slot) => `- ${slot}`)
                .join("\n")}\n\n¿Cuál prefieres?`;
        }

        const reasonText = outsideHours
            ? "That time is outside business hours"
            : "That time is no longer available";

        if (!suggestions.length) {
            return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""}. I could not find another available time within the business hours right now. What other day or time works for you?`;
        }

        return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""}. These times are available:\n\n${suggestions
            .map((slot) => `- ${slot}`)
            .join("\n")}\n\nWhich one would you prefer?`;
    }

    function buildBookingCreatedReply(input: {
        message: string;
        business: BusinessRecord | null;
        serviceName: string;
        scheduledAt: string;
    }) {
        const spanish = isSpanishMessage(input.message);
        const scheduledDate = new Date(input.scheduledAt);
        const scheduledLabel = formatSlotLabel(scheduledDate, input.business, spanish);

        if (spanish) {
            return `Listo, guardé tu solicitud para ${input.serviceName} el ${scheduledLabel}. Está pendiente de confirmación del equipo.`;
        }

        return `Done, I saved your request for ${input.serviceName} on ${scheduledLabel}. It is pending team confirmation.`;
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
        replyOverride: buildBookingCreatedReply({
            message: input.message,
            business,
            serviceName: extracted.serviceName,
            scheduledAt: extracted.scheduledAt,
        }),
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