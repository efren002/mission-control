export const applicationConfig = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1",
  websocketUrl:
    process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/api/v1/ws/events",
} as const;
