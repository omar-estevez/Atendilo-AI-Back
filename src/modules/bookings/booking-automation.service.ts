import { supabase } from "../../config/supabase.js";
import { extractBookingDetailsWithAI } from "../ai/ai.service.js";

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

type BusinessRecord = Record<string, any>;

type SuggestedBookingSlot = {
    scheduledAt: string;
};

type ConversationHistoryItem = {
    sender_type: string;
    content: string;
    created_at?: string | null;
    metadata?: Record<string, any> | null;
};

type ExtractedBookingDetails = {
    isBookingIntent: boolean;
    isConfirmed: boolean;
    customerName: string | null;
    email: string | null;
    phone: string | null;
    serviceName: string | null;
    scheduledAt: string | null;
    estimatedValue: number | null;
    durationMinutes: number | null;
    notes: string | null;
    missingFields: string[];
};

type LastBookingContext = {
    serviceName: string | null;
    scheduledAt: string | null;
    durationMinutes: number | null;
};

type ExistingBookingRecord = {
    id: string;
    business_id: string;
    contact_id: string | null;
    conversation_id: string | null;
    customer_name: string | null;
    service_name: string | null;
    scheduled_at: string | null;
    status: BookingStatus;
    estimated_value: number | null;
    notes: string | null;
};

type TimeChoice = {
    hour: number;
    minute: number;
    period: "am" | "pm" | null;
};

const DEFAULT_BOOKING_DURATION_MINUTES = 60;
const SLOT_STEP_MINUTES = 30;
const MAX_SUGGESTED_SLOTS = 3;
const MAX_AVAILABILITY_LOOKUP_SLOTS = 5;

function addMinutes(date: Date, minutes: number) {
    return new Date(date.getTime() + minutes * 60 * 1000);
}

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

    const noonUtc = zonedTimeToUtc(dateKey, "12:00 pm", timeZone);

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

function normalizeText(value: unknown) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\w\s+áéíóúñü]/gi, " ")
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

function formatSlotLabel(
    date: Date,
    business: BusinessRecord | null,
    spanish: boolean,
    includeDate = true
) {
    const timeZone = getBusinessTimezone(business);

    return new Intl.DateTimeFormat(spanish ? "es-US" : "en-US", {
        timeZone,
        weekday: includeDate ? "short" : undefined,
        month: includeDate ? "short" : undefined,
        day: includeDate ? "numeric" : undefined,
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}

function isSpanishMessage(message: string) {
    return /\b(hola|quiero|necesito|cita|agendar|reservar|disponible|disponibilidad|mañana|manana|gracias|sí|si|hoy|cambiar|cambio)\b/i.test(
        message
    );
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

    const inside =
        start.getTime() >= openUtc.getTime() &&
        end.getTime() <= closeUtc.getTime();

    return {
        inside,
        reason: inside ? null : "outside_business_hours",
    };
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

async function getConversationHistory(
    conversationId: string
): Promise<ConversationHistoryItem[]> {
    const { data, error } = await supabase
        .from("messages")
        .select("sender_type, content, created_at, metadata")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(50);

    if (error) {
        console.error("Get booking history error:", error);
        return [];
    }

    return data || [];
}

async function getContactProfileForBooking(contactId: string | null) {
    if (!contactId) return null;

    const { data, error } = await supabase
        .from("contacts")
        .select("full_name, email, phone")
        .eq("id", contactId)
        .maybeSingle();

    if (error) {
        console.error("Get contact profile for booking error:", error);
        return null;
    }

    if (!data) return null;

    return {
        fullName: data.full_name || null,
        email: data.email || null,
        phone: data.phone || null,
    };
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
    excludeBookingId?: string | null;
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

    const searchStart = addMinutes(start, -24 * 60);

    let query: any = supabase
        .from("bookings")
        .select("id, scheduled_at, status, service_name")
        .eq("business_id", input.businessId)
        .in("status", ["pending", "confirmed"])
        .gte("scheduled_at", searchStart.toISOString())
        .lt("scheduled_at", end.toISOString());

    if (input.excludeBookingId) {
        query = query.neq("id", input.excludeBookingId);
    }

    const { data, error } = await query;

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

        return (
            existingStart.getTime() < end.getTime() &&
            existingEnd.getTime() > start.getTime()
        );
    });

    return {
        available: !conflictingBooking,
        reason: conflictingBooking ? "slot_taken" : null,
        conflictingBookingId: conflictingBooking?.id || null,
    };
}

async function getExistingActiveBooking(input: {
    businessId: string;
    conversationId: string;
}): Promise<ExistingBookingRecord | null> {
    const { data, error } = await supabase
        .from("bookings")
        .select(
            "id, business_id, contact_id, conversation_id, customer_name, service_name, scheduled_at, status, estimated_value, notes"
        )
        .eq("business_id", input.businessId)
        .eq("conversation_id", input.conversationId)
        .in("status", ["pending", "confirmed"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.error("Find existing active booking error:", error);
        return null;
    }

    return data || null;
}

function getBookingAutomationMetadata(item: ConversationHistoryItem) {
    const metadata = item.metadata;

    if (!metadata || typeof metadata !== "object") return null;

    const bookingAutomation =
        metadata.bookingAutomation ||
        metadata.booking_automation ||
        metadata.booking;

    if (!bookingAutomation || typeof bookingAutomation !== "object") {
        return null;
    }

    return bookingAutomation as Record<string, any>;
}

function getLastBookingContext(
    history: ConversationHistoryItem[],
    existingBooking?: ExistingBookingRecord | null
): LastBookingContext {
    if (existingBooking) {
        return {
            serviceName: existingBooking.service_name || null,
            scheduledAt: existingBooking.scheduled_at || null,
            durationMinutes: null,
        };
    }

    for (let index = history.length - 1; index >= 0; index--) {
        const automation = getBookingAutomationMetadata(history[index]);

        if (!automation) continue;

        const extracted = automation.extracted || {};
        const booking = automation.booking || {};

        const serviceName =
            extracted.serviceName ||
            extracted.service_name ||
            booking.service_name ||
            null;

        const scheduledAt =
            extracted.scheduledAt ||
            extracted.scheduled_at ||
            automation.requestedScheduledAt ||
            booking.scheduled_at ||
            null;

        const durationValue =
            extracted.durationMinutes ||
            extracted.duration_minutes ||
            null;

        const durationMinutes = Number(durationValue);

        if (serviceName || scheduledAt || durationMinutes) {
            return {
                serviceName,
                scheduledAt,
                durationMinutes:
                    Number.isFinite(durationMinutes) && durationMinutes > 0
                        ? durationMinutes
                        : null,
            };
        }
    }

    return {
        serviceName: null,
        scheduledAt: null,
        durationMinutes: null,
    };
}

function getLastSuggestedSlots(
    history: ConversationHistoryItem[]
): SuggestedBookingSlot[] {
    for (let index = history.length - 1; index >= 0; index--) {
        const automation = getBookingAutomationMetadata(history[index]);

        const suggestedSlots =
            automation?.suggestedSlots ||
            automation?.suggested_slots ||
            automation?.availableSlots ||
            automation?.available_slots;

        if (Array.isArray(suggestedSlots) && suggestedSlots.length) {
            return suggestedSlots
                .map((slot) => {
                    const scheduledAt =
                        typeof slot === "string"
                            ? slot
                            : slot?.scheduledAt || slot?.scheduled_at;

                    return scheduledAt ? { scheduledAt } : null;
                })
                .filter(Boolean) as SuggestedBookingSlot[];
        }
    }

    return [];
}

function extractTimeChoiceFromMessage(message: string): TimeChoice | null {
    const match = String(message).match(
        /(?:^|\s)(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\b|\?)/i
    );

    if (!match) return null;

    const hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const period = match[3]?.toLowerCase() as "am" | "pm" | undefined;

    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
        return null;
    }

    return {
        hour,
        minute,
        period: period || null,
    };
}

function getHour12(hour24: number) {
    const hour = hour24 % 12;
    return hour === 0 ? 12 : hour;
}

function doesSlotMatchTimeChoice(
    scheduledAt: string,
    choice: TimeChoice,
    business: BusinessRecord | null
) {
    const date = new Date(scheduledAt);

    if (Number.isNaN(date.getTime())) return false;

    const timeZone = getBusinessTimezone(business);
    const parts = getTimeZoneParts(date, timeZone);

    if (parts.minute !== choice.minute) return false;

    if (choice.period) {
        let expectedHour = choice.hour;

        if (choice.period === "pm" && expectedHour < 12) {
            expectedHour += 12;
        }

        if (choice.period === "am" && expectedHour === 12) {
            expectedHour = 0;
        }

        return parts.hour === expectedHour;
    }

    return getHour12(parts.hour) === choice.hour;
}

function resolveSuggestedSlotSelection(input: {
    message: string;
    history: ConversationHistoryItem[];
    business: BusinessRecord | null;
}) {
    const suggestedSlots = getLastSuggestedSlots(input.history);

    if (!suggestedSlots.length) return null;

    const choice = extractTimeChoiceFromMessage(input.message);

    if (!choice) return null;

    return (
        suggestedSlots.find((slot) =>
            doesSlotMatchTimeChoice(slot.scheduledAt, choice, input.business)
        ) || null
    );
}

function isStrongBookingConfirmation(message: string) {
    const text = normalizeText(message);

    return (
        text.includes("yes") ||
        text.includes("confirm") ||
        text.includes("book it") ||
        text.includes("schedule it") ||
        text.includes("go ahead") ||
        text.includes("that works") ||
        text.includes("is good") ||
        text.includes("works for me") ||
        text.includes("ok") ||
        text.includes("okay") ||
        text.includes("perfect") ||
        text.includes("sí") ||
        text.includes("si") ||
        text.includes("confirmo") ||
        text.includes("agendalo") ||
        text.includes("agéndalo") ||
        text.includes("reservalo") ||
        text.includes("resérvalo") ||
        text.includes("me sirve")
    );
}

function isBookingChangeRequest(message: string) {
    const text = normalizeText(message);

    return (
        text.includes("change") ||
        text.includes("reschedule") ||
        text.includes("move") ||
        text.includes("different time") ||
        text.includes("another time") ||
        text.includes("change the hour") ||
        text.includes("change hour") ||
        text.includes("modify") ||
        text.includes("update the time") ||
        text.includes("cambiar") ||
        text.includes("cambio") ||
        text.includes("reagendar") ||
        text.includes("mover") ||
        text.includes("modificar") ||
        text.includes("otra hora") ||
        text.includes("otro horario")
    );
}

function hasRecentBookingChangeRequest(history: ConversationHistoryItem[]) {
    const lastContactMessages = history
        .filter((item) => item.sender_type === "contact")
        .slice(-4);

    return lastContactMessages.some((item) => isBookingChangeRequest(item.content));
}

function isAvailabilityLookupMessage(input: {
    message: string;
    hasLastBookingContext: boolean;
    hasSelectedSuggestedSlot: boolean;
}) {
    if (input.hasSelectedSuggestedSlot) return false;

    const text = normalizeText(input.message);
    const hasSpecificTime = Boolean(extractTimeChoiceFromMessage(input.message));

    if (hasSpecificTime && isStrongBookingConfirmation(input.message)) {
        return false;
    }

    if (
        text.includes("availability") ||
        text.includes("available") ||
        text.includes("openings") ||
        text.includes("what times") ||
        text.includes("which times") ||
        text.includes("today") ||
        text.includes("tomorrow") ||
        text.includes("morning") ||
        text.includes("afternoon") ||
        text.includes("evening") ||
        text.includes("disponibilidad") ||
        text.includes("disponible") ||
        text.includes("hoy") ||
        text.includes("mañana") ||
        text.includes("manana") ||
        text.includes("tarde") ||
        text.includes("noche")
    ) {
        return input.hasLastBookingContext;
    }

    return false;
}

function resolveAvailabilityWindow(message: string) {
    const text = normalizeText(message);

    if (
        text.includes("morning") ||
        text.includes("in the morning") ||
        text.includes("por la mañana") ||
        text.includes("en la mañana")
    ) {
        return "morning";
    }

    if (text.includes("afternoon") || text.includes("tarde")) {
        return "afternoon";
    }

    if (
        text.includes("evening") ||
        text.includes("night") ||
        text.includes("noche")
    ) {
        return "evening";
    }

    return "all_day";
}

function resolveAvailabilityDateKey(input: {
    message: string;
    history: ConversationHistoryItem[];
    business: BusinessRecord | null;
    fallbackScheduledAt?: string | null;
}) {
    const timeZone = getBusinessTimezone(input.business);
    const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
    const text = normalizeText(input.message);

    if (text.includes("today") || text.includes("hoy")) {
        return todayKey;
    }

    if (
        text.includes("tomorrow") ||
        text.includes("mañana") ||
        text.includes("manana")
    ) {
        return addDaysToDateKey(todayKey, 1);
    }

    for (let index = input.history.length - 1; index >= 0; index--) {
        const item = input.history[index];

        if (item.sender_type !== "contact") continue;

        const previousText = normalizeText(item.content);

        if (previousText.includes("today") || previousText.includes("hoy")) {
            return todayKey;
        }

        if (
            previousText.includes("tomorrow") ||
            previousText.includes("mañana") ||
            previousText.includes("manana")
        ) {
            return addDaysToDateKey(todayKey, 1);
        }
    }

    if (input.fallbackScheduledAt) {
        const fallbackDate = new Date(input.fallbackScheduledAt);

        if (!Number.isNaN(fallbackDate.getTime())) {
            return getDateKeyInTimeZone(fallbackDate, timeZone);
        }
    }

    return todayKey;
}

function getWindowBounds(input: {
    business: BusinessRecord | null;
    dateKey: string;
    window: string;
}) {
    const timeZone = getBusinessTimezone(input.business);
    const dayHours = getBusinessHoursForDateKey(
        input.business,
        input.dateKey,
        timeZone
    );

    let openUtc: Date | null = null;
    let closeUtc: Date | null = null;

    if (!dayHours) {
        openUtc = zonedTimeToUtc(input.dateKey, "9:00 am", timeZone);
        closeUtc = zonedTimeToUtc(input.dateKey, "5:00 pm", timeZone);
    } else if (!dayHours.enabled) {
        return null;
    } else {
        openUtc = zonedTimeToUtc(input.dateKey, dayHours.open, timeZone);
        closeUtc = zonedTimeToUtc(input.dateKey, dayHours.close, timeZone);
    }

    if (!openUtc || !closeUtc) return null;

    if (closeUtc.getTime() <= openUtc.getTime()) {
        closeUtc = addMinutes(closeUtc, 24 * 60);
    }

    let start = openUtc;
    let end = closeUtc;

    const noon = zonedTimeToUtc(input.dateKey, "12:00 pm", timeZone);
    const fivePm = zonedTimeToUtc(input.dateKey, "5:00 pm", timeZone);

    if (input.window === "morning" && noon) {
        end = new Date(Math.min(end.getTime(), noon.getTime()));
    }

    if (input.window === "afternoon" && noon && fivePm) {
        start = new Date(Math.max(start.getTime(), noon.getTime()));
        end = new Date(Math.min(end.getTime(), fivePm.getTime()));
    }

    if (input.window === "evening" && fivePm) {
        start = new Date(Math.max(start.getTime(), fivePm.getTime()));
    }

    if (end.getTime() <= start.getTime()) return null;

    return { start, end };
}

async function findAvailableSlotsForWindow(input: {
    businessId: string;
    business: BusinessRecord | null;
    dateKey: string;
    window: string;
    durationMinutes: number;
    limit?: number;
    excludeBookingId?: string | null;
    excludeScheduledAt?: string | null;
}) {
    const limit = input.limit || MAX_AVAILABILITY_LOOKUP_SLOTS;
    const timeZone = getBusinessTimezone(input.business);
    const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
    const minimumNoticeMinutes = getMinimumNoticeMinutes(input.business);
    const earliestAllowed = addMinutes(new Date(), minimumNoticeMinutes);

    const bounds = getWindowBounds({
        business: input.business,
        dateKey: input.dateKey,
        window: input.window,
    });

    if (!bounds) return [];

    let candidateStart = bounds.start;

    if (input.dateKey === todayKey) {
        candidateStart = new Date(
            Math.max(candidateStart.getTime(), earliestAllowed.getTime())
        );
    }

    let candidate = roundUpToStep(candidateStart, SLOT_STEP_MINUTES);
    const availableSlots: SuggestedBookingSlot[] = [];

    while (
        addMinutes(candidate, input.durationMinutes).getTime() <=
        bounds.end.getTime() &&
        availableSlots.length < limit
    ) {
        const candidateIso = candidate.toISOString();

        const sameAsExcluded =
            input.excludeScheduledAt &&
            isSameScheduledMinute(candidateIso, input.excludeScheduledAt);

        if (!sameAsExcluded) {
            const availability = await isBookingSlotAvailable({
                businessId: input.businessId,
                business: input.business,
                scheduledAt: candidateIso,
                durationMinutes: input.durationMinutes,
                excludeBookingId: input.excludeBookingId,
            });

            if (availability.available) {
                availableSlots.push({
                    scheduledAt: candidateIso,
                });
            }
        }

        candidate = addMinutes(candidate, SLOT_STEP_MINUTES);
    }

    return availableSlots;
}

async function findAvailableBookingSlots(input: {
    businessId: string;
    business: BusinessRecord | null;
    requestedScheduledAt: string;
    durationMinutes?: number | null;
    limit?: number;
    excludeBookingId?: string | null;
}) {
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

        for (
            let attempt = 0;
            attempt < 96 && suggestedSlots.length < limit;
            attempt++
        ) {
            const availability = await isBookingSlotAvailable({
                businessId: input.businessId,
                business,
                scheduledAt: candidate.toISOString(),
                durationMinutes,
                excludeBookingId: input.excludeBookingId,
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

    for (
        let dayOffset = 0;
        dayOffset < 10 && suggestedSlots.length < limit;
        dayOffset++
    ) {
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
                excludeBookingId: input.excludeBookingId,
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

function isSameScheduledMinute(first: string, second: string) {
    const firstDate = new Date(first);
    const secondDate = new Date(second);

    if (Number.isNaN(firstDate.getTime()) || Number.isNaN(secondDate.getTime())) {
        return false;
    }

    return Math.abs(firstDate.getTime() - secondDate.getTime()) < 60 * 1000;
}

function buildDateTimeFromTimeChoice(input: {
    dateKey: string;
    choice: TimeChoice;
    business: BusinessRecord | null;
}) {
    const timeZone = getBusinessTimezone(input.business);
    const period =
        input.choice.period ||
        (input.choice.hour >= 7 && input.choice.hour <= 11 ? "am" : "pm");

    return zonedTimeToUtc(
        input.dateKey,
        `${input.choice.hour}:${String(input.choice.minute).padStart(
            2,
            "0"
        )} ${period}`,
        timeZone
    );
}

function resolveRequestedScheduledAtFromMessage(input: {
    message: string;
    history: ConversationHistoryItem[];
    business: BusinessRecord | null;
    existingBooking?: ExistingBookingRecord | null;
    selectedSuggestedSlot?: SuggestedBookingSlot | null;
    extractedScheduledAt?: string | null;
}) {
    if (input.selectedSuggestedSlot?.scheduledAt) {
        return input.selectedSuggestedSlot.scheduledAt;
    }

    const choice = extractTimeChoiceFromMessage(input.message);

    if (!choice) {
        if (input.extractedScheduledAt) {
            return input.extractedScheduledAt;
        }

        return null;
    }

    const fallbackScheduledAt =
        input.existingBooking?.scheduled_at || input.extractedScheduledAt || null;

    const dateKey = resolveAvailabilityDateKey({
        message: input.message,
        history: input.history,
        business: input.business,
        fallbackScheduledAt,
    });

    const date = buildDateTimeFromTimeChoice({
        dateKey,
        choice,
        business: input.business,
    });

    return date?.toISOString() || null;
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
        .map((slot) =>
            formatSlotLabel(new Date(slot.scheduledAt), input.business, spanish)
        )
        .filter(Boolean);

    const outsideHours = input.reason === "outside_business_hours";

    if (spanish) {
        const reasonText = outsideHours
            ? "Ese horario está fuera del horario del negocio"
            : "Ese horario ya no está disponible";

        if (!suggestions.length) {
            return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""
                }. No encontré otro horario disponible dentro del horario del negocio por ahora. ¿Qué otro día u hora te funciona?`;
        }

        return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""
            }. Tengo estos horarios disponibles:\n\n${suggestions
                .map((slot) => `- ${slot}`)
                .join("\n")}\n\n¿Cuál prefieres?`;
    }

    const reasonText = outsideHours
        ? "That time is outside business hours"
        : "That time is no longer available";

    if (!suggestions.length) {
        return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""
            }. I could not find another available time within business hours right now. What other day or time works for you?`;
    }

    return `${reasonText}${requestedLabel ? ` (${requestedLabel})` : ""}. These times are available:\n\n${suggestions
        .map((slot) => `- ${slot}`)
        .join("\n")}\n\nWhich one would you prefer?`;
}

function buildAvailabilityLookupReply(input: {
    message: string;
    business: BusinessRecord | null;
    serviceName: string;
    dateKey: string;
    window: string;
    availableSlots: SuggestedBookingSlot[];
}) {
    const spanish = isSpanishMessage(input.message);
    const timeZone = getBusinessTimezone(input.business);
    const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
    const tomorrowKey = addDaysToDateKey(todayKey, 1);

    const dateText =
        input.dateKey === todayKey
            ? spanish
                ? "hoy"
                : "today"
            : input.dateKey === tomorrowKey
                ? spanish
                    ? "mañana"
                    : "tomorrow"
                : input.dateKey;

    const windowText =
        input.window === "morning"
            ? spanish
                ? "en la mañana"
                : "in the morning"
            : input.window === "afternoon"
                ? spanish
                    ? "en la tarde"
                    : "in the afternoon"
                : input.window === "evening"
                    ? spanish
                        ? "en la noche"
                        : "in the evening"
                    : "";

    const slots = input.availableSlots.map((slot) =>
        formatSlotLabel(new Date(slot.scheduledAt), input.business, spanish, false)
    );

    if (spanish) {
        if (!slots.length) {
            return `No encontré horarios disponibles para ${input.serviceName} ${dateText}${windowText ? ` ${windowText}` : ""
                } dentro del horario del negocio. ¿Quieres intentar otro día u otra hora?`;
        }

        return `Estos horarios están disponibles para ${input.serviceName} ${dateText}${windowText ? ` ${windowText}` : ""
            }:\n\n${slots.map((slot) => `- ${slot}`).join("\n")}\n\n¿Cuál prefieres?`;
    }

    if (!slots.length) {
        return `I couldn't find available times for ${input.serviceName} ${dateText}${windowText ? ` ${windowText}` : ""
            } within business hours. Would another day or time work?`;
    }

    return `These times are available for ${input.serviceName} ${dateText}${windowText ? ` ${windowText}` : ""
        }:\n\n${slots.map((slot) => `- ${slot}`).join("\n")}\n\nWhich one would you prefer?`;
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

function buildBookingUpdatedReply(input: {
    message: string;
    business: BusinessRecord | null;
    serviceName: string;
    scheduledAt: string;
}) {
    const spanish = isSpanishMessage(input.message);
    const scheduledDate = new Date(input.scheduledAt);
    const scheduledLabel = formatSlotLabel(scheduledDate, input.business, spanish);

    if (spanish) {
        return `Listo, actualicé tu reserva para ${input.serviceName} al ${scheduledLabel}. Sigue pendiente de confirmación del equipo.`;
    }

    return `Done, I updated your booking for ${input.serviceName} to ${scheduledLabel}. It is still pending team confirmation.`;
}

function buildRescheduleOptionsReply(input: {
    message: string;
    business: BusinessRecord | null;
    serviceName: string;
    availableSlots: SuggestedBookingSlot[];
}) {
    const spanish = isSpanishMessage(input.message);

    const slots = input.availableSlots.map((slot) =>
        formatSlotLabel(new Date(slot.scheduledAt), input.business, spanish)
    );

    if (spanish) {
        if (!slots.length) {
            return `Claro, puedo ayudarte a cambiar la hora de ${input.serviceName}, pero no encontré otros horarios disponibles dentro del horario del negocio. ¿Qué otra hora o día te sirve?`;
        }

        return `Claro, puedo ayudarte a cambiar la hora de ${input.serviceName}. Estos horarios están disponibles:\n\n${slots
            .map((slot) => `- ${slot}`)
            .join("\n")}\n\n¿Cuál prefieres?`;
    }

    if (!slots.length) {
        return `Sure, I can help change the time for your ${input.serviceName} booking, but I could not find other available times within business hours. What other day or time works for you?`;
    }

    return `Sure, I can help change the time for your ${input.serviceName} booking. These times are available:\n\n${slots
        .map((slot) => `- ${slot}`)
        .join("\n")}\n\nWhich one would you prefer?`;
}

function normalizeExtractedBookingDetails(value: any): ExtractedBookingDetails {
    return {
        isBookingIntent: Boolean(value?.isBookingIntent),
        isConfirmed: Boolean(value?.isConfirmed),
        customerName: value?.customerName || null,
        email: value?.email || null,
        phone: value?.phone || null,
        serviceName: value?.serviceName || null,
        scheduledAt: value?.scheduledAt || null,
        estimatedValue:
            Number.isFinite(Number(value?.estimatedValue)) &&
                Number(value?.estimatedValue) > 0
                ? Number(value.estimatedValue)
                : null,
        durationMinutes:
            Number.isFinite(Number(value?.durationMinutes)) &&
                Number(value?.durationMinutes) > 0
                ? Number(value.durationMinutes)
                : null,
        notes: value?.notes || null,
        missingFields: Array.isArray(value?.missingFields)
            ? value.missingFields
            : [],
    };
}

function applyBookingContext(input: {
    extracted: ExtractedBookingDetails;
    lastBookingContext: LastBookingContext;
    selectedSuggestedSlot: SuggestedBookingSlot | null;
}) {
    const extracted = {
        ...input.extracted,
    };

    if (!extracted.serviceName && input.lastBookingContext.serviceName) {
        extracted.serviceName = input.lastBookingContext.serviceName;
    }

    if (!extracted.scheduledAt && input.lastBookingContext.scheduledAt) {
        extracted.scheduledAt = input.lastBookingContext.scheduledAt;
    }

    if (!extracted.durationMinutes && input.lastBookingContext.durationMinutes) {
        extracted.durationMinutes = input.lastBookingContext.durationMinutes;
    }

    if (input.selectedSuggestedSlot?.scheduledAt) {
        extracted.scheduledAt = input.selectedSuggestedSlot.scheduledAt;
        extracted.isConfirmed = true;

        extracted.missingFields = (extracted.missingFields || []).filter(
            (field) => field !== "scheduledAt" && field !== "confirmation"
        );
    }

    return extracted;
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

async function handleBookingReschedule(input: {
    businessId: string;
    conversationId: string;
    contactId: string | null;
    message: string;
    analysisSummary?: string;
    business: BusinessRecord | null;
    history: ConversationHistoryItem[];
    existingBooking: ExistingBookingRecord;
    extracted: ExtractedBookingDetails;
    selectedSuggestedSlot: SuggestedBookingSlot | null;
    durationMinutes: number;
}) {
    const serviceName =
        input.extracted.serviceName ||
        input.existingBooking.service_name ||
        "your service";

    const requestedScheduledAt = resolveRequestedScheduledAtFromMessage({
        message: input.message,
        history: input.history,
        business: input.business,
        existingBooking: input.existingBooking,
        selectedSuggestedSlot: input.selectedSuggestedSlot,
        extractedScheduledAt: input.extracted.scheduledAt,
    });

    if (!requestedScheduledAt) {
        const fallbackDate =
            input.existingBooking.scheduled_at || new Date().toISOString();

        const dateKey = getDateKeyInTimeZone(
            new Date(fallbackDate),
            getBusinessTimezone(input.business)
        );

        const availableSlots = await findAvailableSlotsForWindow({
            businessId: input.businessId,
            business: input.business,
            dateKey,
            window: "all_day",
            durationMinutes: input.durationMinutes,
            limit: MAX_SUGGESTED_SLOTS,
            excludeBookingId: input.existingBooking.id,
            excludeScheduledAt: input.existingBooking.scheduled_at,
        });

        const replyOverride = buildRescheduleOptionsReply({
            message: input.message,
            business: input.business,
            serviceName,
            availableSlots,
        });

        await supabase.from("ai_activity_logs").insert({
            business_id: input.businessId,
            conversation_id: input.conversationId,
            contact_id: input.contactId,
            type: "workflow_triggered",
            status: "success",
            title: "Booking reschedule options suggested",
            description:
                "Customer asked to change an existing booking. AI suggested available times.",
            metadata: {
                source: "booking_automation",
                existingBookingId: input.existingBooking.id,
                suggestedSlots: availableSlots,
                extracted: input.extracted,
            },
        });

        return {
            created: false,
            updated: false,
            reason: "reschedule_options_suggested",
            bookingId: input.existingBooking.id,
            contactId: input.contactId,
            suggestedSlots: availableSlots,
            extracted: input.extracted,
            replyOverride,
        };
    }

    const availability = await isBookingSlotAvailable({
        businessId: input.businessId,
        business: input.business,
        scheduledAt: requestedScheduledAt,
        durationMinutes: input.durationMinutes,
        excludeBookingId: input.existingBooking.id,
    });

    if (!availability.available) {
        const suggestedSlots = await findAvailableBookingSlots({
            businessId: input.businessId,
            business: input.business,
            requestedScheduledAt,
            durationMinutes: input.durationMinutes,
            limit: MAX_SUGGESTED_SLOTS,
            excludeBookingId: input.existingBooking.id,
        });

        const replyOverride = buildSlotUnavailableReply({
            message: input.message,
            business: input.business,
            requestedScheduledAt,
            suggestedSlots,
            reason: availability.reason,
        });

        await supabase.from("ai_activity_logs").insert({
            business_id: input.businessId,
            conversation_id: input.conversationId,
            contact_id: input.contactId,
            type: "workflow_triggered",
            status: "warning",
            title: "Booking reschedule slot unavailable",
            description:
                "Customer requested to reschedule, but the selected time is unavailable.",
            metadata: {
                source: "booking_automation",
                existingBookingId: input.existingBooking.id,
                requestedScheduledAt,
                suggestedSlots,
                availability,
                extracted: input.extracted,
            },
        });

        return {
            created: false,
            updated: false,
            reason: availability.reason || "reschedule_slot_unavailable",
            bookingId: input.existingBooking.id,
            contactId: input.contactId,
            suggestedSlots,
            extracted: {
                ...input.extracted,
                scheduledAt: requestedScheduledAt,
            },
            replyOverride,
        };
    }

    const updatedNotes = [
        input.existingBooking.notes,
        `Rescheduled by AI from ${input.existingBooking.scheduled_at} to ${requestedScheduledAt}.`,
        input.analysisSummary,
    ]
        .filter(Boolean)
        .join("\n");

    const { data: updatedBooking, error: updateError } = await supabase
        .from("bookings")
        .update({
            service_name: serviceName,
            scheduled_at: requestedScheduledAt,
            status: "pending" satisfies BookingStatus,
            estimated_value:
                input.extracted.estimatedValue ??
                input.existingBooking.estimated_value ??
                0,
            notes: updatedNotes || null,
        })
        .eq("id", input.existingBooking.id)
        .eq("business_id", input.businessId)
        .select("*")
        .single();

    if (updateError || !updatedBooking) {
        console.error("Update automated booking error:", updateError);

        return {
            created: false,
            updated: false,
            reason: "booking_update_failed",
            error: updateError?.message,
            bookingId: input.existingBooking.id,
            contactId: input.contactId,
            extracted: input.extracted,
        };
    }

    await supabase.from("ai_activity_logs").insert({
        business_id: input.businessId,
        conversation_id: input.conversationId,
        contact_id: input.contactId,
        type: "appointment_scheduled",
        status: "success",
        title: "Booking rescheduled by AI",
        description: `Booking updated to ${requestedScheduledAt}.`,
        metadata: {
            source: "booking_automation",
            bookingId: updatedBooking.id,
            previousScheduledAt: input.existingBooking.scheduled_at,
            newScheduledAt: requestedScheduledAt,
            extracted: {
                ...input.extracted,
                scheduledAt: requestedScheduledAt,
            },
            booking: updatedBooking,
        },
    });

    return {
        created: false,
        updated: true,
        reason: "booking_rescheduled",
        booking: updatedBooking,
        bookingId: updatedBooking.id,
        contactId: input.contactId,
        extracted: {
            ...input.extracted,
            scheduledAt: requestedScheduledAt,
        },
        replyOverride: buildBookingUpdatedReply({
            message: input.message,
            business: input.business,
            serviceName,
            scheduledAt: requestedScheduledAt,
        }),
    };
}

export async function processBookingAutomation(input: BookingAutomationInput) {
    const lowerMessage = input.message.toLowerCase();

    const business = await getBusinessForBookingAutomation(input.businessId);
    const history = await getConversationHistory(input.conversationId);
    const contactProfile = await getContactProfileForBooking(input.contactId);
    const existingBooking = await getExistingActiveBooking({
        businessId: input.businessId,
        conversationId: input.conversationId,
    });

    const lastBookingContext = getLastBookingContext(history, existingBooking);

    const selectedSuggestedSlot = resolveSuggestedSlotSelection({
        message: input.message,
        history,
        business,
    });

    const hasLastBookingContext = Boolean(
        lastBookingContext.serviceName ||
        lastBookingContext.scheduledAt ||
        lastBookingContext.durationMinutes
    );

    const changeRequest =
        Boolean(existingBooking) &&
        (isBookingChangeRequest(input.message) ||
            hasRecentBookingChangeRequest(history) ||
            Boolean(selectedSuggestedSlot));

    const availabilityLookup = isAvailabilityLookupMessage({
        message: input.message,
        hasLastBookingContext,
        hasSelectedSuggestedSlot: Boolean(selectedSuggestedSlot),
    });

    const shouldCheckBooking =
        input.analysis.intent === "booking_request" ||
        input.analysis.intent === "booking_ready" ||
        Boolean(selectedSuggestedSlot) ||
        availabilityLookup ||
        changeRequest ||
        lowerMessage.includes("book") ||
        lowerMessage.includes("booking") ||
        lowerMessage.includes("appointment") ||
        lowerMessage.includes("schedule") ||
        lowerMessage.includes("reserve") ||
        lowerMessage.includes("availability") ||
        lowerMessage.includes("available") ||
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

    const aiExtracted = await extractBookingDetailsWithAI({
        business,
        currentDateIso: new Date().toISOString(),
        customerProfile: contactProfile,
        messages: history.map((item) => ({
            senderType: item.sender_type,
            content: item.content,
        })),
    });

    const extracted = applyBookingContext({
        extracted: normalizeExtractedBookingDetails(aiExtracted),
        lastBookingContext,
        selectedSuggestedSlot,
    });

    if (
        !extracted.isBookingIntent &&
        !selectedSuggestedSlot &&
        !availabilityLookup &&
        !changeRequest
    ) {
        return {
            created: false,
            reason: "ai_not_booking_intent",
            extracted,
        };
    }

    const updatedContactId = await updateOrCreateBookingContact({
        businessId: input.businessId,
        currentContactId: input.contactId || existingBooking?.contact_id || null,
        conversationId: input.conversationId,
        customerName: extracted.customerName,
        email: extracted.email,
        phone: extracted.phone,
    });

    const fallbackCustomerName =
        extracted.customerName ||
        existingBooking?.customer_name ||
        (await getContactFallbackName(updatedContactId));

    const bookingDurationMinutes =
        extracted.durationMinutes ||
        lastBookingContext.durationMinutes ||
        getServiceDurationMinutes(
            business,
            extracted.serviceName || lastBookingContext.serviceName,
            DEFAULT_BOOKING_DURATION_MINUTES
        );

    if (existingBooking && changeRequest) {
        return handleBookingReschedule({
            businessId: input.businessId,
            conversationId: input.conversationId,
            contactId: updatedContactId,
            message: input.message,
            analysisSummary: input.analysis.aiSummary,
            business,
            history,
            existingBooking,
            extracted,
            selectedSuggestedSlot,
            durationMinutes: bookingDurationMinutes,
        });
    }

    if (availabilityLookup && !selectedSuggestedSlot) {
        const serviceName = extracted.serviceName || lastBookingContext.serviceName;

        if (!serviceName) {
            return {
                created: false,
                reason: "missing_service_for_availability_lookup",
                extracted,
                contactId: updatedContactId,
                replyOverride: isSpanishMessage(input.message)
                    ? "Claro. ¿Para cuál servicio quieres revisar disponibilidad?"
                    : "Sure. Which service would you like to check availability for?",
            };
        }

        const dateKey = resolveAvailabilityDateKey({
            message: input.message,
            history,
            business,
            fallbackScheduledAt:
                extracted.scheduledAt || lastBookingContext.scheduledAt,
        });

        const window = resolveAvailabilityWindow(input.message);

        const availableSlots = await findAvailableSlotsForWindow({
            businessId: input.businessId,
            business,
            dateKey,
            window,
            durationMinutes: bookingDurationMinutes,
            limit: MAX_AVAILABILITY_LOOKUP_SLOTS,
            excludeBookingId: existingBooking?.id || null,
            excludeScheduledAt: existingBooking?.scheduled_at || null,
        });

        const replyOverride = buildAvailabilityLookupReply({
            message: input.message,
            business,
            serviceName,
            dateKey,
            window,
            availableSlots,
        });

        await supabase.from("ai_activity_logs").insert({
            business_id: input.businessId,
            conversation_id: input.conversationId,
            contact_id: updatedContactId,
            type: "workflow_triggered",
            status: "success",
            title: "Booking availability checked",
            description:
                "AI returned real available booking slots within business hours.",
            metadata: {
                source: "booking_automation",
                dateKey,
                window,
                serviceName,
                availableSlots,
                extracted,
            },
        });

        return {
            created: false,
            reason: "availability_lookup",
            extracted,
            contactId: updatedContactId,
            suggestedSlots: availableSlots,
            replyOverride,
        };
    }

    if (existingBooking) {
        return {
            created: false,
            reason: "booking_already_exists",
            bookingId: existingBooking.id,
            contactId: updatedContactId,
        };
    }

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
        updated: false,
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