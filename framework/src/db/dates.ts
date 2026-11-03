export const EVENT_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

export const eventDateMessage = (field: string) =>
  `${field} must be an ISO date (YYYY-MM-DD) or timestamp (YYYY-MM-DDTHH:MM:SSZ)`

export const isEventDate = (value: string) => EVENT_DATE.test(value) && !Number.isNaN(Date.parse(value))

export function checkEventDate(value: string, field: string): string {
  if (!isEventDate(value)) throw new Error(eventDateMessage(field))
  return value
}
