export type EmailStatus = {
  isBound: boolean;
  maskedEmail: string | null;
  emailVerified: boolean;
};

export type EmailUpdateInput = {
  walletAddress: string;
  email: string;
  signature: string;
  signedMessage: string;
};

export async function fetchEmailStatus(address: string) {
  const response = await fetch(`/api/user/email?address=${encodeURIComponent(address)}`);
  return parseJson<EmailStatus>(response);
}

export async function updateEmail(input: EmailUpdateInput) {
  const response = await fetch("/api/user/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  return parseJson<{ walletAddress: string; email: string | null; emailVerified: boolean }>(response);
}

async function parseJson<T extends object>(response: Response) {
  const data = (await response.json()) as T | { error?: string; details?: unknown };

  if (!response.ok) {
    const message = "error" in data && data.error ? data.error : "Request failed";
    throw new Error(message);
  }

  return data as T;
}
