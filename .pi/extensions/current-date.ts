import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CURRENT_DATE_MARKER = "{{PI_CURRENT_DATE}}";

function isoDateInTimeZone(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone,
	}).formatToParts(date);
	const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)!.value;

	return `${value("year")}-${value("month")}-${value("day")}`;
}

export function formatCurrentDate(
	date = new Date(),
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
	const calendarDate = new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone,
	}).format(date);

	return `${calendarDate} (${isoDateInTimeZone(date, timeZone)}; ${timeZone})`;
}

export default function currentDate(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (!event.systemPrompt.includes(CURRENT_DATE_MARKER)) return;

		return {
			systemPrompt: event.systemPrompt.replaceAll(CURRENT_DATE_MARKER, formatCurrentDate()),
		};
	});
}
