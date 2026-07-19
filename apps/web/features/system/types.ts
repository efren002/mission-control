export type ComponentStatus = "operational" | "unavailable";

export interface ComponentHealth {
  status: ComponentStatus;
}

export interface HealthResponse {
  status: "operational" | "degraded";
  service: string;
  components: Record<string, ComponentHealth>;
}

export interface RealtimeEvent {
  type: string;
  source?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface FeedEvent extends RealtimeEvent {
  receivedAt: number;
}
