import {
  ChatListingProvider,
  type ChatListingProviderConfig,
} from "./chat-listing-provider.js";
export type OpenRouterListingProviderConfig = Omit<
  ChatListingProviderConfig,
  "backend" | "sessionId"
>;
export class OpenRouterListingProvider extends ChatListingProvider {
  constructor(config: OpenRouterListingProviderConfig) {
    super({ ...config, backend: "openrouter" });
  }
}
