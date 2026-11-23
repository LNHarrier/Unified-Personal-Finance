import { requireOptionalNativeModule } from "expo-modules-core";

export type NotificationCandidate = {
  candidateId: string;
  sourcePackage: string;
  receivedAt: string;
  receivedAtMillis: number;
  amountMinor: number;
  currency: string;
  direction: "income" | "expense";
  description: string;
  referenceHash: string;
};

export type NotificationCaptureModule = {
  hasNotificationAccess(): Promise<boolean>;
  openNotificationSettings(): Promise<void>;
  setCaptureEnabled(enabled: boolean): Promise<void>;
  isCaptureEnabled(): Promise<boolean>;
  getCandidates(): Promise<NotificationCandidate[]>;
  removeCandidate(candidateId: string): Promise<void>;
  clearCandidates(): Promise<void>;
};

export const notificationCapture =
  requireOptionalNativeModule<NotificationCaptureModule>("FinovaNotificationCapture");
