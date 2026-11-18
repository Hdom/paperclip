import type { MaintenanceStatus } from "@paperclipai/shared";
import { api } from "./client";

export type MaintenanceRequestReceipt = {found:boolean;requestId:string;kind?:string;state?:"active"|"settled"|"recorded";generation?:number;continuationReleased?:false};
export const maintenanceApi = {
  receipt:(requestId:string)=>api.get<MaintenanceRequestReceipt>(`/instance/maintenance/requests/${encodeURIComponent(requestId)}`),
  status: (task = false) => api.get<MaintenanceStatus>(`/instance/maintenance${task ? "?view=task" : ""}`),
  start: (input: { expectedGeneration: number; requestId: string; operatorNote: string }) => api.post("/instance/maintenance", input),
  release: (input: { generation: number; ownerId: string; requestId: string; reviewFingerprint?: string }) => api.post("/instance/maintenance/release", input),
  recover: (input: { generation: number; ownerId: string; requestId: string; companyId: string; issueId: string; actionId: string; runId: string }) => api.post("/instance/maintenance/recover-source", input),
};
