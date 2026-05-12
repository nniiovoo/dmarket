import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

export const resend = apiKey ? new Resend(apiKey) : null;

export function isEmailEnabled() {
  return resend !== null;
}

export function emailFrom() {
  return process.env.EMAIL_FROM ?? "onboarding@resend.dev";
}

export function appBaseUrl() {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
