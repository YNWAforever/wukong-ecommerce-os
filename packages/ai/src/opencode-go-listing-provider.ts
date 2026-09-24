import {
  ChatListingProvider,
  type ChatListingProviderConfig,
} from "./chat-listing-provider.js";
export type OpenCodeGoListingProviderConfig = Omit<
  ChatListingProviderConfig,
  "backend" | "sessionId"
> & { sessionId: string };
/** Fixed Go endpoint and pinned vision model. Session identity is the immutable operation ID. */
export class OpenCodeGoListingProvider extends ChatListingProvider {
  constructor(config: OpenCodeGoListingProviderConfig) {
    super({ ...config, backend: "opencode-go" });
  }
}
