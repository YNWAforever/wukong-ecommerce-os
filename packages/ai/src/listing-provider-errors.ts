export class ListingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedAssetError extends ListingProviderError {}
export class ProviderApiError extends ListingProviderError {}
export class ProviderRefusalError extends ListingProviderError {}
export class ProviderOutputError extends ListingProviderError {}
