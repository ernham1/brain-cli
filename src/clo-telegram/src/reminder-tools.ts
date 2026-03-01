import type { ReminderStore, Reminder } from "./scheduler.js";

// --- 리마인더 도구 실행 ---

interface ScheduleInput {
  chatId: number;
  datetime: string;
  description: string;
  repeat?: "daily" | "weekly" | null;
}

interface ListInput {
  chatId: number;
}

interface CancelInput {
  reminderId: string;
}

function generateReminderId(datetime: string): string {
  const d = new Date(datetime);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `rem_${dateStr}_${timeStr}_${rand}`;
}

export function executeReminderTool(
  toolName: string,
  input: Record<string, unknown>,
  reminderStore: ReminderStore,
): string {
  try {
    switch (toolName) {
      case "schedule_reminder":
        return scheduleReminder(input as unknown as ScheduleInput, reminderStore);
      case "list_reminders":
        return listReminders(input as unknown as ListInput, reminderStore);
      case "cancel_reminder":
        return cancelReminder(input as unknown as CancelInput, reminderStore);
      default:
        return `알 수 없는 리마인더 도구: ${toolName}`;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `리마인더 도구 오류 (${toolName}): ${msg}`;
  }
}

function scheduleReminder(input: ScheduleInput, store: ReminderStore): string {
  const reminder: Reminder = {
    id: generateReminderId(input.datetime),
    chatId: input.chatId,
    datetime: input.datetime,
    description: input.description,
    repeat: input.repeat || null,
    notified: false,
  };

  store.add(reminder);

  const d = new Date(input.datetime);
  const timeStr = d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const repeatStr = input.repeat
    ? ` (${input.repeat === "daily" ? "매일 반복" : "매주 반복"})`
    : "";

  return `리마인더 설정 완료!\nID: ${reminder.id}\n시간: ${timeStr}${repeatStr}\n내용: ${input.description}`;
}

function listReminders(input: ListInput, store: ReminderStore): string {
  const reminders = store.list(input.chatId);

  if (reminders.length === 0) {
    return "설정된 리마인더가 없습니다.";
  }

  const lines = reminders.map((r) => {
    const d = new Date(r.datetime);
    const timeStr = d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const repeatStr = r.repeat
      ? ` (${r.repeat === "daily" ? "매일" : "매주"})`
      : "";
    return `• [${r.id}] ${timeStr}${repeatStr} — ${r.description}`;
  });

  return `리마인더 목록 (${reminders.length}개):\n${lines.join("\n")}`;
}

function cancelReminder(input: CancelInput, store: ReminderStore): string {
  const removed = store.cancel(input.reminderId);
  return removed
    ? `리마인더 취소 완료: ${input.reminderId}`
    : `해당 리마인더를 찾을 수 없습니다: ${input.reminderId}`;
}
