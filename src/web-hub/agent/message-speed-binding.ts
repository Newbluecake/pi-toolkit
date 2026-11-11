/** Scalar adapter for main/child observations. Never reads content/usage or hands a snapshot to the tap. */
import { generationOwnData as own, isGenerationId } from "../protocol/message-generation.js";

export interface MessageSpeedBinding {
  responseId: string;
  provider: string;
  api: string;
  model: string;
}
export function messageSpeedBinding(event: unknown): MessageSpeedBinding | undefined {
  const message = own(event, "message");
  const responseId = own(message, "responseId");
  const provider = own(message, "provider");
  const api = own(message, "api");
  const model = own(message, "model");
  return isGenerationId(responseId) && isGenerationId(provider) && isGenerationId(api) && isGenerationId(model)
    ? { responseId, provider, api, model }
    : undefined;
}
