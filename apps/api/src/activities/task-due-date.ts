import { activity, and, gte, isNull, lt, type SQL } from "@crm/db";
import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { TASKS } from "./activities-config";

const DAY_MS = 86_400_000;

export const TASK_WINDOWS = [
	"overdue",
	"today",
	"week",
	"later",
	"none",
] as const;

export type TaskWindow = (typeof TASK_WINDOWS)[number];

export const taskDueDayInput = z.iso.date();

export type TaskDayBoundaries = {
	startOfToday: Date;
	startOfTomorrow: Date;
	startOfNextWeek: Date;
};

export function taskDayBoundaries(reference: Date): TaskDayBoundaries {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: TASKS.day.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(reference);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((item) => item.type === type)?.value ?? "";
	const day = `${part("year")}-${part("month")}-${part("day")}`;
	const startOfToday = new Date(`${day}T00:00:00.000Z`);
	const startOfTomorrow = new Date(startOfToday.getTime() + DAY_MS);
	const weekday = startOfToday.getUTCDay();
	const daysUntilNextWeek = (TASKS.day.weekStartsOn - weekday + 7) % 7 || 7;
	const startOfNextWeek = new Date(
		startOfToday.getTime() + daysUntilNextWeek * DAY_MS,
	);

	return { startOfToday, startOfTomorrow, startOfNextWeek };
}

export function taskDueDay(value: string): Date {
	const parsed = taskDueDayInput.safeParse(value);
	if (!parsed.success) {
		throw new BadRequestException(`"${value}" is not a calendar day.`);
	}

	return new Date(`${parsed.data}T00:00:00.000Z`);
}

export function parseTaskDueDay(value: string | null | undefined): Date | null {
	if (value === null || value === undefined) return null;
	return taskDueDay(value);
}

export function serializeTaskDueDay(value: Date | null): string | null {
	return value?.toISOString().slice(0, 10) ?? null;
}

export function taskWindowFilter(
	window: TaskWindow,
	reference: Date,
): SQL | undefined {
	const { startOfToday, startOfTomorrow, startOfNextWeek } =
		taskDayBoundaries(reference);

	switch (window) {
		case "overdue":
			return lt(activity.dueAt, startOfToday);
		case "today":
			return and(
				gte(activity.dueAt, startOfToday),
				lt(activity.dueAt, startOfTomorrow),
			);
		case "week":
			return and(
				gte(activity.dueAt, startOfTomorrow),
				lt(activity.dueAt, startOfNextWeek),
			);
		case "later":
			return gte(activity.dueAt, startOfNextWeek);
		case "none":
			return isNull(activity.dueAt);
	}
}
